//! One git worktree per session, and its diff
//!
//! Each agent gets its own working directory, so agents touching the same repository do not collide.
//! Diffs come from git rather than ACP diffs (Codex and OpenCode do not return diffs).

pub mod history;
pub mod ops;
pub mod remote;

/// A command to run. On Windows the program is looked up the way a shell would (`gh` finds `gh.exe`, `code` finds
/// `code.cmd`) and runs without flashing a console window; elsewhere this is `Command::new`
pub(crate) fn command(program: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let resolved = which::which(program).map(|p| p.into_os_string()).unwrap_or_else(|_| program.into());
        let mut c = Command::new(resolved);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

/// git, with the settings that would let a repository run programs of its own during Plyfold's read-only calls
/// turned off: the file system monitor (run by status, diff and ls-files) and the untracked cache. Diffs add
/// --no-ext-diff and --no-textconv. Hooks still run for commit, merge and push, as they do for the git CLI; a worktree
/// whose `.git` was replaced is refused before those run (see verify)
pub fn git_command() -> Command {
    let mut c = command("git");
    c.args(["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]);
    c
}

/// Whether a program is on the PATH
pub(crate) fn has_program(program: &str) -> bool {
    which::which(program).is_ok()
}
pub use ops::WtStatus;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("{}", plyfold_i18n::tr!("git {} に失敗しました: {}", "git {} failed: {}", "git {} 失败：{}", .args, .stderr))]
    Git { args: String, stderr: String },
    #[error("{}", plyfold_i18n::tr!("git を実行できません: {}", "Cannot run git: {}", "无法运行 git：{}", .0))]
    Io(#[from] std::io::Error),
    #[error("{}", plyfold_i18n::tr!("{} は git リポジトリではありません", "{} is not a git repository", "{} 不是 git 仓库", .0.display()))]
    NotARepo(PathBuf),
    #[error("{0}")]
    Op(String),
    #[error(
        "{}",
        plyfold_i18n::tr!(
            "このリポジトリにはコミットがないため worktree を作れません。worktree をオフにして、リポジトリで直接作業してください",
            "This repository has no commits, so Plyfold cannot create a worktree. Turn off the worktree option to work directly in the repository",
            "此仓库尚无提交记录，无法创建 worktree。请关闭 worktree 选项，直接在仓库中工作"
        )
    )]
    NoCommits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Worktree {
    /// Root of the original repository
    pub repo: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    /// The commit at creation time (the diff base)
    pub base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FileStat {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    /// A new file git does not track yet
    pub untracked: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Diff {
    pub files: Vec<FileStat>,
    /// Unified diff (ready to display as is)
    pub patch: String,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let out = git_command().args(args).current_dir(dir).output()?;
    if !out.status.success() {
        return Err(WorktreeError::Git { args: args.join(" "), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Exit code 1 also counts as success (`git diff --no-index` returns 1 when there are differences)
fn git_diff_ok(dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let out = git_command().args(args).current_dir(dir).output()?;
    match out.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
        _ => Err(WorktreeError::Git { args: args.join(" "), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() }),
    }
}

pub fn repo_root(dir: &Path) -> Result<PathBuf, WorktreeError> {
    git(dir, &["rev-parse", "--show-toplevel"]).map(|s| PathBuf::from(s.trim())).map_err(|_| WorktreeError::NotARepo(dir.to_path_buf()))
}

/// The commit HEAD points at. None when the directory is not a repository, or has no commits yet.
/// Uses the same git helper as the other worktree operations
pub fn head(dir: &Path) -> Option<String> {
    let s = git(dir, &["rev-parse", "--verify", "HEAD"]).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// Manages where worktrees are placed
pub struct Worktrees {
    root: PathBuf,
}

impl Worktrees {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Without `base`, branches off the current HEAD
    pub fn create(&self, repo: &Path, session_id: &str, base: Option<&str>) -> Result<Worktree, WorktreeError> {
        let repo = repo_root(repo)?;
        let base_expr = format!("{}^{{commit}}", base.unwrap_or("HEAD"));
        let base = git(&repo, &["rev-parse", "--verify", &base_expr])
            .map_err(|e| if base.is_none() && head(&repo).is_none() { WorktreeError::NoCommits } else { e })?
            .trim()
            .to_string();
        let name = repo.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
        let path = self.root.join(format!("{name}-{}", short_hash(&repo.display().to_string()))).join(session_id);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let branch = format!("plyfold/{session_id}");
        git(&repo, &["worktree", "add", "-q", "-b", &branch, &path.display().to_string(), &base])?;
        Ok(Worktree { repo, path, branch, base })
    }

    /// Removes the worktree. With `delete_branch`, also deletes the branch (the work is lost)
    pub fn remove(&self, wt: &Worktree, delete_branch: bool) -> Result<(), WorktreeError> {
        let repo_alive = wt.repo.is_dir() && git(&wt.repo, &["rev-parse", "--git-dir"]).is_ok();
        if !repo_alive {
            // The repository was moved or deleted, so git cannot be asked: only the worktree's own folder is left.
            // Only a folder under Plyfold's worktree root is removed, never the repository's path
            if wt.path != wt.repo && wt.path.starts_with(&self.root) && wt.path.exists() {
                std::fs::remove_dir_all(&wt.path)?;
            }
            return Ok(());
        }
        if wt.path.exists() {
            git(&wt.repo, &["worktree", "remove", "--force", &wt.path.display().to_string()])?;
        } else {
            // The folder is already gone: drop git's record of it
            let _ = git(&wt.repo, &["worktree", "prune"]);
        }
        // A branch that is already gone needs no deleting
        if delete_branch && git(&wt.repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", wt.branch)]).is_ok() {
            git(&wt.repo, &["branch", "-D", &wt.branch])?;
        }
        Ok(())
    }
}

/// Check that the worktree is still the repository's own: its `.git` is a plain file pointing at an entry under the
/// repository's .git/worktrees, and that entry points back at it. An agent may write anywhere inside its worktree,
/// including over `.git`, to point git at a directory (with a config and hooks) of its own; Plyfold then refuses to run
/// git there rather than run what that directory says
pub fn verify(wt: &Worktree) -> Result<(), WorktreeError> {
    let tampered = |why: &str| {
        WorktreeError::Op(plyfold_i18n::tr!(
            "worktree {} の .git が書き換えられているので、git を実行しません（{why}）",
            "The .git of the worktree {} has been changed, so Plyfold does not run git in it ({why})",
            "worktree {} 的 .git 已被更改，因此不在其中运行 git（{why}）",
            wt.path.display()
        ))
    };
    // A session working in the repository itself (no worktree of its own) has the repository's .git
    if wt.path == wt.repo {
        return Ok(());
    }
    let dotgit = wt.path.join(".git");
    let meta = std::fs::symlink_metadata(&dotgit).map_err(|_| tampered("no .git"))?;
    if !meta.is_file() {
        return Err(tampered("not a file"));
    }
    let text = std::fs::read_to_string(&dotgit)?;
    let pointed = text.trim().strip_prefix("gitdir:").map(str::trim).ok_or_else(|| tampered("no gitdir line"))?;
    let pointed = wt.path.join(pointed);
    let common = git(&wt.repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let entries = std::fs::canonicalize(PathBuf::from(common.trim()).join("worktrees")).map_err(|_| tampered("no worktrees in the repository"))?;
    let entry = std::fs::canonicalize(&pointed).map_err(|_| tampered("gitdir does not exist"))?;
    if entry.parent() != Some(entries.as_path()) {
        return Err(tampered("gitdir is not the repository's"));
    }
    let back = std::fs::read_to_string(entry.join("gitdir")).map_err(|_| tampered("no way back"))?;
    let back = std::fs::canonicalize(back.trim()).map_err(|_| tampered("no way back"))?;
    if back != std::fs::canonicalize(&dotgit)? {
        return Err(tampered("the entry is another worktree's"));
    }
    Ok(())
}

/// Whether git still lists `path` as a worktree of `repo` (it does after the folder is deleted, until it is pruned)
pub fn is_registered(repo: &Path, path: &Path) -> bool {
    let Ok(list) = git(repo, &["worktree", "list", "--porcelain"]) else { return false };
    // The folder may be gone, so its parent (which stays) is resolved and the name added: that settles links, and on
    // Windows short names (RUNNER~1) and git's forward slashes
    let key = |p: &Path| {
        let full = match (p.parent().and_then(|d| std::fs::canonicalize(d).ok()), p.file_name()) {
            (Some(d), Some(f)) => d.join(f),
            _ => p.to_path_buf(),
        };
        let s = full.display().to_string();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s).replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    let want = key(path);
    list.lines().filter_map(|l| l.strip_prefix("worktree ")).any(|p| key(Path::new(p)) == want)
}

/// Whether the worktree still has the branch assigned when the session started.
pub fn on_session_branch(wt: &Worktree) -> bool {
    git(&wt.path, &["symbolic-ref", "--quiet", "--short", "HEAD"]).is_ok_and(|branch| branch.trim() == wt.branch)
}

/// Diff from the base commit to the current working tree (committed, uncommitted and untracked)
pub fn diff(wt: &Worktree) -> Result<Diff, WorktreeError> {
    verify(wt)?;
    let dir = &wt.path;
    let comparison = if !wt.branch.is_empty() && !on_session_branch(wt) {
        git(&wt.repo, &["rev-parse", "--verify", "HEAD"]).ok().map(|value| value.trim().to_string()).unwrap_or_else(|| wt.base.clone())
    } else {
        wt.base.clone()
    };
    let mut out = Diff::default();

    for line in git(dir, &["diff", "--no-ext-diff", "--no-textconv", "--numstat", &comparison, "--"])?.lines() {
        let mut parts = line.splitn(3, '\t');
        let (a, r, p) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        out.files.push(FileStat { path: p.to_string(), added: a.parse().unwrap_or(0), removed: r.parse().unwrap_or(0), untracked: false, binary: a == "-" });
    }
    out.patch = git(dir, &["diff", "--no-ext-diff", "--no-textconv", &comparison, "--"])?;

    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    for p in untracked.split('\0').filter(|s| !s.is_empty()) {
        let patch = git_diff_ok(dir, &["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", p])?;
        let numstat = git_diff_ok(dir, &["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--numstat", "--", "/dev/null", p])?;
        let added = numstat.split('\t').next().unwrap_or("");
        out.files.push(FileStat { path: p.to_string(), added: added.parse().unwrap_or(0), removed: 0, untracked: true, binary: added == "-" });
        out.patch.push_str(&patch);
    }
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn short_hash(s: &str) -> String {
    // FNV-1a (it only needs to be stable)
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", h as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_follow_the_language() {
        let e = WorktreeError::NotARepo(PathBuf::from("/x"));
        plyfold_i18n::set_lang("en");
        assert_eq!(e.to_string(), "/x is not a git repository");
        plyfold_i18n::set_lang("ja");
        assert_eq!(e.to_string(), "/x は git リポジトリではありません");
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-wt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        // macOS: resolve /var → /private/var. Windows: keep the path as is (canonicalize adds a \\?\ prefix git rejects)
        if cfg!(windows) { d } else { d.canonicalize().unwrap() }
    }

    fn init_repo(dir: &Path) {
        let g = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        g(&["init", "-q", "-b", "main"]);
        // Keep line endings as written (Windows runners convert to CRLF on checkout otherwise)
        g(&["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "/target\n").unwrap();
        g(&["add", "-A"]);
        g(&["commit", "-qm", "init"]);
    }

    #[test]
    fn checkout_and_history_keep_the_workspace_and_remote_refs_distinct() {
        use history::Checkout;

        let base = tmp("checkout-history");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let first = head(&repo).unwrap();
        git(&repo, &["remote", "add", "origin", "."]).unwrap();
        git(&repo, &["update-ref", "refs/remotes/origin/topic", &first]).unwrap();
        git(&repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic"]).unwrap();
        history::checkout(&repo, Checkout::Remote { name: "origin/topic".into() }).unwrap();
        assert_eq!(git(&repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).unwrap().trim(), "origin/topic");

        let wt = Worktrees::new(base.join("wts")).create(&repo, "session", None).unwrap();
        assert!(history::checkout(&wt.path, Checkout::Local { name: "topic".into() }).is_err());
        history::checkout(&wt.path, Checkout::Local { name: "main".into() }).unwrap();
        assert_eq!(history::history(&repo).unwrap().branch.as_deref(), Some("topic"));
        history::checkout(&wt.path, Checkout::NewBranch { name: "new-branch".into() }).unwrap();
        assert_eq!(history::history(&wt.path).unwrap().branch.as_deref(), Some("new-branch"));

        history::checkout(&wt.path, Checkout::Commit { sha: first }).unwrap();
        git(&wt.path, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "detached commit"]).unwrap();
        let log = history::history(&wt.path).unwrap();
        assert!(log.branch.is_none());
        assert!(log.branches.iter().any(|b| b.remote && b.name == "origin/topic"));
        assert!(!log.branches.iter().any(|b| b.name == "origin/HEAD"));
        assert!(log.rows.iter().filter_map(|r| r.commit.as_ref()).any(|c| Some(&c.sha) == log.head.as_ref() && c.subject == "detached commit"));
    }

    #[test]
    fn removing_a_worktree_works_when_the_repository_or_the_folder_is_gone() {
        let base = tmp("remove-gone");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wts = Worktrees::new(base.join("wts"));

        // The worktree's folder is already gone: git's record and the branch are still cleaned up
        let a = wts.create(&repo, "a", None).unwrap();
        std::fs::remove_dir_all(&a.path).unwrap();
        wts.remove(&a, true).unwrap();
        assert!(git(&repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", a.branch)]).is_err());
        // Removing it again is harmless
        wts.remove(&a, true).unwrap();

        // The repository is gone: the worktree's folder under Plyfold's root is removed, nothing else
        let b = wts.create(&repo, "b", None).unwrap();
        std::fs::remove_dir_all(&repo).unwrap();
        assert!(b.path.exists());
        wts.remove(&b, true).unwrap();
        assert!(!b.path.exists());

        // A path outside the worktree root is never deleted
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let stray = Worktree { repo: repo.clone(), path: outside.clone(), branch: "x".into(), base: "main".into() };
        wts.remove(&stray, true).unwrap();
        assert!(outside.exists());
    }

    #[test]
    fn checkout_preserves_modified_and_ignored_files() {
        use history::Checkout;

        let repo = tmp("checkout-local-files");
        init_repo(&repo);
        history::checkout(&repo, Checkout::NewBranch { name: "target-branch".into() }).unwrap();
        std::fs::write(repo.join("target"), "tracked by target-branch").unwrap();
        std::fs::write(repo.join("a.txt"), "changed by target-branch").unwrap();
        git(&repo, &["add", "-f", "target", "a.txt"]).unwrap();
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "changes"]).unwrap();
        history::checkout(&repo, Checkout::Local { name: "main".into() }).unwrap();
        let switch = || history::checkout(&repo, Checkout::Local { name: "target-branch".into() });
        std::fs::write(repo.join("a.txt"), "working copy").unwrap();
        assert!(switch().is_err());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "working copy");
        git(&repo, &["restore", "a.txt"]).unwrap();
        std::fs::write(repo.join("target"), "ignored file").unwrap();
        assert!(switch().is_err());
        assert_eq!(std::fs::read_to_string(repo.join("target")).unwrap(), "ignored file");
        assert_eq!(history::history(&repo).unwrap().branch.as_deref(), Some("main"));
    }

    /// What a repository's own config or a replaced .git could make Plyfold's git run
    #[test]
    fn repository_settings_do_not_run_programs_and_a_replaced_git_is_refused() {
        let base = tmp("guard");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wts = Worktrees::new(base.join("wts"));
        let wt = wts.create(&repo, "s1", None).unwrap();
        verify(&wt).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let marker = base.join("ran.txt");
            let script = base.join("monitor.sh");
            std::fs::write(&script, format!("#!/bin/sh\necho ran >> '{}'\n", marker.display())).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            let ok = Command::new("git").args(["config", "core.fsmonitor", &script.display().to_string()]).current_dir(&repo).status().unwrap();
            assert!(ok.success());
            std::fs::write(wt.path.join("new.txt"), "x\n").unwrap();
            diff(&wt).unwrap();
            ops::status(&wt).unwrap();
            assert!(!marker.exists(), "the repository's fsmonitor ran");
        }

        // The agent replaces the worktree's .git with one pointing at a directory of its own
        let evil = base.join("evil-gitdir");
        std::fs::create_dir_all(&evil).unwrap();
        let original = std::fs::read_to_string(wt.path.join(".git")).unwrap();
        std::fs::write(wt.path.join(".git"), format!("gitdir: {}\n", evil.display())).unwrap();
        assert!(diff(&wt).is_err());
        assert!(ops::status(&wt).is_err());
        assert!(ops::commit(&wt, "x").is_err());
        std::fs::write(wt.path.join(".git"), original).unwrap();
        verify(&wt).unwrap();

        // Deleted from inside: git still lists it until pruned
        std::fs::remove_dir_all(&wt.path).unwrap();
        assert!(is_registered(&repo, &wt.path));
        git(&repo, &["worktree", "prune"]).unwrap();
        assert!(!is_registered(&repo, &wt.path));
    }

    #[test]
    fn worktree_requires_a_commit() {
        let base = tmp("empty-repo");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let status = Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&repo).status().unwrap();
        assert!(status.success());
        let err = Worktrees::new(base.join("wts")).create(&repo, "s-empty", None).unwrap_err();
        assert!(matches!(err, WorktreeError::NoCommits));
        assert!(err.to_string().contains("worktree"));
    }

    #[test]
    fn create_diff_remove() {
        let base = tmp("cdr");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wts = Worktrees::new(base.join("wts"));

        let wt = wts.create(&repo.join("."), "s1", None).unwrap();
        assert_eq!(head(&repo).as_deref(), Some(wt.base.as_str()));
        // git may spell the same folder differently (C:/ vs C:\\, long vs short names on Windows)
        assert_eq!(wt.repo.canonicalize().unwrap(), repo.canonicalize().unwrap());
        assert!(wt.path.join("a.txt").exists());
        assert_eq!(wt.branch, "plyfold/s1");

        // No changes
        assert!(diff(&wt).unwrap().files.is_empty());

        // A modified file + a new untracked file + an ignored file
        std::fs::write(wt.path.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(wt.path.join("new.txt"), "hello\n").unwrap();
        std::fs::create_dir_all(wt.path.join("target")).unwrap();
        std::fs::write(wt.path.join("target/junk"), "x").unwrap();
        let d = diff(&wt).unwrap();
        let names: Vec<&str> = d.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "new.txt"]);
        assert_eq!((d.files[0].added, d.files[0].removed, d.files[0].untracked), (2, 1, false));
        assert_eq!((d.files[1].added, d.files[1].untracked), (1, true));
        assert!(d.patch.contains("+TWO") && d.patch.contains("+hello"));

        // The original repository is untouched
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\ntwo\n");

        wts.remove(&wt, true).unwrap();
        assert!(!wt.path.exists());
        assert!(git(&repo, &["branch", "--list", "plyfold/s1"]).unwrap().trim().is_empty());
    }

    #[test]
    fn not_a_repo() {
        let d = tmp("norepo");
        assert!(matches!(Worktrees::new(d.join("w")).create(&d, "s", None), Err(WorktreeError::NotARepo(_))));
        assert!(head(&d).is_none());
    }
}
