//! セッションごとの git worktree と、その差分
//!
//! エージェントごとに作業場所を分けて、同じリポジトリを触ってもぶつからないようにする。
//! 差分は ACP の diff に頼らず git から作る（Codex や OpenCode は diff を返さないため）。

pub mod ops;
pub use ops::WtStatus;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("git {args} に失敗しました: {stderr}")]
    Git { args: String, stderr: String },
    #[error("git を実行できません: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0} は git リポジトリではありません")]
    NotARepo(PathBuf),
    #[error("{0}")]
    Op(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Worktree {
    /// 元のリポジトリのルート
    pub repo: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    /// 作ったときのコミット（差分の基準）
    pub base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FileStat {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    /// git がまだ追跡していない新しいファイル
    pub untracked: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Diff {
    pub files: Vec<FileStat>,
    /// unified diff（そのまま表示できる）
    pub patch: String,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let out = Command::new("git").args(args).current_dir(dir).output()?;
    if !out.status.success() {
        return Err(WorktreeError::Git {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 終了コード 1 も成功扱い（`git diff --no-index` は差分があると 1 を返す）
fn git_diff_ok(dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let out = Command::new("git").args(args).current_dir(dir).output()?;
    match out.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
        _ => Err(WorktreeError::Git {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        }),
    }
}

pub fn repo_root(dir: &Path) -> Result<PathBuf, WorktreeError> {
    git(dir, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim()))
        .map_err(|_| WorktreeError::NotARepo(dir.to_path_buf()))
}

/// worktree を置く場所の管理
pub struct Worktrees {
    root: PathBuf,
}

impl Worktrees {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `base` を省くと、今の HEAD から切る
    pub fn create(&self, repo: &Path, session_id: &str, base: Option<&str>) -> Result<Worktree, WorktreeError> {
        let repo = repo_root(repo)?;
        let base = git(&repo, &["rev-parse", "--verify", &format!("{}^{{commit}}", base.unwrap_or("HEAD"))])?
            .trim()
            .to_string();
        let name = repo.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
        let path = self.root.join(format!("{name}-{}", short_hash(&repo.display().to_string()))).join(session_id);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let branch = format!("plyfold/{session_id}");
        git(&repo, &["worktree", "add", "-q", "-b", &branch, &path.display().to_string(), &base])?;
        Ok(Worktree { repo, path, branch, base })
    }

    /// worktree を消す。`delete_branch` なら枝も消す（作業内容は失われる）
    pub fn remove(&self, wt: &Worktree, delete_branch: bool) -> Result<(), WorktreeError> {
        git(&wt.repo, &["worktree", "remove", "--force", &wt.path.display().to_string()])?;
        if delete_branch {
            git(&wt.repo, &["branch", "-D", &wt.branch])?;
        }
        Ok(())
    }
}

/// 基準のコミットから、今の作業ツリーまでの差分（コミット済み・未コミット・未追跡をすべて含む）
pub fn diff(wt: &Worktree) -> Result<Diff, WorktreeError> {
    let dir = &wt.path;
    let mut out = Diff::default();

    for line in git(dir, &["diff", "--numstat", &wt.base])?.lines() {
        let mut parts = line.splitn(3, '\t');
        let (a, r, p) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        out.files.push(FileStat {
            path: p.to_string(),
            added: a.parse().unwrap_or(0),
            removed: r.parse().unwrap_or(0),
            untracked: false,
            binary: a == "-",
        });
    }
    out.patch = git(dir, &["diff", &wt.base])?;

    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    for p in untracked.split('\0').filter(|s| !s.is_empty()) {
        let patch = git_diff_ok(dir, &["diff", "--no-index", "--", "/dev/null", p])?;
        let numstat = git_diff_ok(dir, &["diff", "--no-index", "--numstat", "--", "/dev/null", p])?;
        let added = numstat.split('\t').next().unwrap_or("");
        out.files.push(FileStat {
            path: p.to_string(),
            added: added.parse().unwrap_or(0),
            removed: 0,
            untracked: true,
            binary: added == "-",
        });
        out.patch.push_str(&patch);
    }
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn short_hash(s: &str) -> String {
    // FNV-1a（安定していればよい）
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

        // 変更なし
        assert!(diff(&wt).unwrap().files.is_empty());

        // 既存ファイルの変更 + 未追跡の新規 + 無視されるファイル
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

        // 元のリポジトリには影響しない
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
