//! One git worktree per session, and its diff
//!
//! Each agent gets its own working directory, so agents touching the same repository do not collide.
//! Diffs come from git rather than ACP diffs (Codex and OpenCode do not return diffs).

pub mod ops;
pub mod remote;
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
    let out = Command::new("git").args(args).current_dir(dir).output()?;
    if !out.status.success() {
        return Err(WorktreeError::Git { args: args.join(" "), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Exit code 1 also counts as success (`git diff --no-index` returns 1 when there are differences)
fn git_diff_ok(dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let out = Command::new("git").args(args).current_dir(dir).output()?;
    match out.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
        _ => Err(WorktreeError::Git { args: args.join(" "), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() }),
    }
}

pub fn repo_root(dir: &Path) -> Result<PathBuf, WorktreeError> {
    git(dir, &["rev-parse", "--show-toplevel"]).map(|s| PathBuf::from(s.trim())).map_err(|_| WorktreeError::NotARepo(dir.to_path_buf()))
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
        let base = git(&repo, &["rev-parse", "--verify", &format!("{}^{{commit}}", base.unwrap_or("HEAD"))])?.trim().to_string();
        let name = repo.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
        let path = self.root.join(format!("{name}-{}", short_hash(&repo.display().to_string()))).join(session_id);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let branch = format!("plyfold/{session_id}");
        git(&repo, &["worktree", "add", "-q", "-b", &branch, &path.display().to_string(), &base])?;
        Ok(Worktree { repo, path, branch, base })
    }

    /// Removes the worktree. With `delete_branch`, also deletes the branch (the work is lost)
    pub fn remove(&self, wt: &Worktree, delete_branch: bool) -> Result<(), WorktreeError> {
        git(&wt.repo, &["worktree", "remove", "--force", &wt.path.display().to_string()])?;
        if delete_branch {
            git(&wt.repo, &["branch", "-D", &wt.branch])?;
        }
        Ok(())
    }
}

/// Diff from the base commit to the current working tree (committed, uncommitted and untracked)
pub fn diff(wt: &Worktree) -> Result<Diff, WorktreeError> {
    let dir = &wt.path;
    let mut out = Diff::default();

    for line in git(dir, &["diff", "--numstat", &wt.base])?.lines() {
        let mut parts = line.splitn(3, '\t');
        let (a, r, p) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        out.files.push(FileStat { path: p.to_string(), added: a.parse().unwrap_or(0), removed: r.parse().unwrap_or(0), untracked: false, binary: a == "-" });
    }
    out.patch = git(dir, &["diff", &wt.base])?;

    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    for p in untracked.split('\0').filter(|s| !s.is_empty()) {
        let patch = git_diff_ok(dir, &["diff", "--no-index", "--", "/dev/null", p])?;
        let numstat = git_diff_ok(dir, &["diff", "--no-index", "--numstat", "--", "/dev/null", p])?;
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
        d.canonicalize().unwrap()
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
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "/target\n").unwrap();
        g(&["add", "-A"]);
        g(&["commit", "-qm", "init"]);
    }

    #[test]
    fn create_diff_remove() {
        let base = tmp("cdr");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wts = Worktrees::new(base.join("wts"));

        let wt = wts.create(&repo.join("."), "s1", None).unwrap();
        assert_eq!(wt.repo, repo);
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
    }
}
