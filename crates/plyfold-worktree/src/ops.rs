//! Actions on the diff view: commit, merge into the original repository, discard

use serde::{Deserialize, Serialize};

use crate::{Worktree, WorktreeError, git};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct WtStatus {
    /// There are uncommitted changes (including untracked files)
    pub dirty: bool,
    /// Number of commits made on top of the base commit
    pub commits: u32,
    /// Merge target (the branch currently checked out in the original repository). None for a detached HEAD
    pub target: Option<String>,
    /// All commits made are already in the merge target
    pub merged: bool,
}

fn fail(msg: impl Into<String>) -> WorktreeError {
    WorktreeError::Op(msg.into())
}

pub fn status(wt: &Worktree) -> Result<WtStatus, WorktreeError> {
    let dirty = !git(&wt.path, &["status", "--porcelain"])?.trim().is_empty();
    let commits = git(&wt.path, &["rev-list", "--count", &format!("{}..HEAD", wt.base)])?.trim().parse().unwrap_or(0);
    let target = git(&wt.repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let merged = commits > 0
        && target.as_ref().is_some_and(|t| {
            crate::command("git").args(["merge-base", "--is-ancestor", &wt.branch, t]).current_dir(&wt.repo).status().is_ok_and(|s| s.success())
        });
    Ok(WtStatus { dirty, commits, target, merged })
}

/// Commits all changes in the working tree. Returns the short hash
pub fn commit(wt: &Worktree, message: &str) -> Result<String, WorktreeError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(fail(plyfold_i18n::tr!("コミットのメッセージが空です", "The commit message is empty", "提交信息为空")));
    }
    git(&wt.path, &["add", "-A"])?;
    if git(&wt.path, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err(fail(plyfold_i18n::tr!("コミットする変更がありません", "No changes to commit", "没有可提交的更改")));
    }
    git(&wt.path, &["commit", "-q", "-m", message])?;
    Ok(git(&wt.path, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

/// Merges the session branch into the branch currently checked out in the original repository. Returns the target's name.
/// On a conflict, aborts the merge and restores the original repository to its previous state
pub fn merge(wt: &Worktree) -> Result<String, WorktreeError> {
    let st = status(wt)?;
    if st.dirty {
        return Err(fail(plyfold_i18n::tr!(
            "コミットしていない変更があります。先にコミットしてください",
            "There are uncommitted changes. Commit them first",
            "有未提交的更改。请先提交"
        )));
    }
    if st.commits == 0 {
        return Err(fail(plyfold_i18n::tr!("取り込むコミットがありません", "No commits to merge", "没有可合并的提交")));
    }
    let target = st.target.ok_or_else(|| {
        fail(plyfold_i18n::tr!(
            "元のリポジトリの HEAD が枝を指していないので、取り込み先が決まりません",
            "The original repository's HEAD is not on a branch, so there is no merge target",
            "原仓库的 HEAD 不在分支上，无法确定合并目标"
        ))
    })?;
    if st.merged {
        return Err(fail(plyfold_i18n::tr!("{target} にはもう取り込んであります", "Already merged into {target}", "已合并到 {target}")));
    }
    let msg = format!("Merge {} (Plyfold)", wt.branch);
    if let Err(e) = git(&wt.repo, &["merge", "--no-ff", "--no-edit", "-m", &msg, &wt.branch]) {
        let _ = git(&wt.repo, &["merge", "--abort"]);
        return Err(fail(plyfold_i18n::tr!(
            "{target} に取り込めませんでした。変更がぶつかったか、元のリポジトリに未コミットの変更があります。元のリポジトリは取り込む前の状態に戻しました。\n{e}",
            "Could not merge into {target}. The changes conflict, or the original repository has uncommitted changes. The original repository was restored to its state before the merge.\n{e}",
            "无法合并到 {target}。更改存在冲突，或原仓库有未提交的更改。原仓库已恢复到合并前的状态。\n{e}"
        )));
    }
    Ok(target)
}

fn has(cmd: &str) -> bool {
    crate::has_program(cmd)
}

/// Pushes the branch to origin and opens a GitHub PR (via gh). Returns the PR URL
pub fn create_pr(wt: &Worktree, title: &str) -> Result<String, WorktreeError> {
    let st = status(wt)?;
    if st.dirty {
        return Err(fail(plyfold_i18n::tr!(
            "コミットしていない変更があります。先にコミットしてください",
            "There are uncommitted changes. Commit them first",
            "有未提交的更改。请先提交"
        )));
    }
    if st.commits == 0 {
        return Err(fail(plyfold_i18n::tr!("PR にするコミットがありません", "No commits for a PR", "没有可用于创建 PR 的提交")));
    }
    if !has("gh") {
        return Err(fail(plyfold_i18n::tr!(
            "gh（GitHub CLI）が見つかりません。brew install gh で入れて、gh auth login してください",
            "gh (GitHub CLI) not found. Install it with brew install gh, then run gh auth login",
            "找不到 gh（GitHub CLI）。请用 brew install gh 安装，然后运行 gh auth login"
        )));
    }
    if git(&wt.repo, &["remote", "get-url", "origin"]).is_err() {
        return Err(fail(plyfold_i18n::tr!("このリポジトリには origin がありません", "This repository has no origin remote", "此仓库没有 origin")));
    }
    git(&wt.path, &["push", "-q", "-u", "origin", &wt.branch])?;
    let body = plyfold_i18n::tr!("Plyfold のセッションで作った変更です。", "Changes made in a Plyfold session.", "在 Plyfold 会话中做出的更改。");
    let mut args = vec!["pr", "create", "--head", &wt.branch, "--title", title, "--body", &body];
    if let Some(t) = st.target.as_deref() {
        args.extend(["--base", t]);
    }
    let out = crate::command("gh").args(&args).current_dir(&wt.path).output()?;
    if !out.status.success() {
        return Err(fail(plyfold_i18n::tr!(
            "PR を作れませんでした（枝は push 済みです）: {}",
            "Could not create the PR (the branch was pushed): {}",
            "无法创建 PR（分支已推送）：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").trim().to_string())
}

/// Opens the worktree in an editor. `prefer` is "auto" / "zed" / "cursor" / "code" / "finder".
/// Returns the name of the editor that was opened (Finder if auto finds nothing)
pub fn open_in_editor(wt: &Worktree, prefer: &str) -> Result<String, WorktreeError> {
    let path = wt.path.display().to_string();
    let editors = [("zed", "Zed"), ("cursor", "Cursor"), ("code", "VS Code")];
    if let Some((cmd, name)) = editors.iter().find(|(c, _)| *c == prefer) {
        if !has(cmd) {
            return Err(fail(plyfold_i18n::tr!(
                "{name} のコマンド（{cmd}）が見つかりません。設定でエディタを選び直してください",
                "{name} command ({cmd}) not found. Choose another editor in Settings",
                "找不到 {name} 的命令（{cmd}）。请在设置中重新选择编辑器"
            )));
        }
        crate::command(cmd).arg(&path).spawn()?;
        return Ok((*name).into());
    }
    for (cmd, name) in editors.iter().filter(|_| prefer != "finder") {
        if has(cmd) {
            crate::command(cmd).arg(&path).spawn()?;
            return Ok((*name).into());
        }
    }
    // No editor: show the folder in Finder / File Explorer
    #[cfg(target_os = "macos")]
    {
        crate::command("open").arg(&path).spawn()?;
        Ok("Finder".into())
    }
    #[cfg(windows)]
    {
        crate::command("explorer").arg(&path).spawn()?;
        Ok("File Explorer".into())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        crate::command("xdg-open").arg(&path).spawn()?;
        Ok("Files".into())
    }
}

/// Resets to the base commit (drops commits, uncommitted changes and untracked files; ignored files are kept)
pub fn discard(wt: &Worktree) -> Result<(), WorktreeError> {
    git(&wt.path, &["reset", "-q", "--hard", &wt.base])?;
    git(&wt.path, &["clean", "-fdq"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::*;
    use crate::Worktrees;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-ops-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn g(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"]).args(args).current_dir(dir).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    fn setup(name: &str) -> (PathBuf, Worktree) {
        let base = tmp(name);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        // Commits made in tests take their author from this repository's config
        g(&repo, &["config", "user.name", "t"]);
        g(&repo, &["config", "user.email", "t@example.invalid"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-qm", "init"]);
        let wt = Worktrees::new(base.join("wts")).create(&repo, "s1", None).unwrap();
        (repo, wt)
    }

    #[test]
    fn commit_then_merge() {
        let (repo, wt) = setup("merge");
        assert_eq!(status(&wt).unwrap(), WtStatus { dirty: false, commits: 0, target: Some("main".into()), merged: false });
        assert!(commit(&wt, "x").is_err(), "nothing to commit");
        std::fs::write(wt.path.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(wt.path.join("new.txt"), "n\n").unwrap();
        assert!(status(&wt).unwrap().dirty);
        assert!(merge(&wt).is_err(), "dirty");
        commit(&wt, "add two").unwrap();
        let st = status(&wt).unwrap();
        assert!(!st.dirty && st.commits == 1 && !st.merged);
        assert_eq!(merge(&wt).unwrap(), "main");
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\ntwo\n");
        assert!(repo.join("new.txt").exists());
        assert!(status(&wt).unwrap().merged);
        assert!(merge(&wt).is_err(), "already merged");
    }

    #[test]
    fn conflicting_merge_is_aborted() {
        let (repo, wt) = setup("conflict");
        std::fs::write(wt.path.join("a.txt"), "theirs\n").unwrap();
        commit(&wt, "theirs").unwrap();
        std::fs::write(repo.join("a.txt"), "ours\n").unwrap();
        g(&repo, &["commit", "-qam", "ours"]);
        assert!(merge(&wt).is_err());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "ours\n");
        assert!(!repo.join(".git/MERGE_HEAD").exists());
    }

    #[test]
    fn discard_goes_back_to_base() {
        let (_repo, wt) = setup("discard");
        std::fs::write(wt.path.join("a.txt"), "changed\n").unwrap();
        commit(&wt, "c").unwrap();
        std::fs::write(wt.path.join("b.txt"), "untracked\n").unwrap();
        discard(&wt).unwrap();
        assert_eq!(std::fs::read_to_string(wt.path.join("a.txt")).unwrap(), "one\n");
        assert!(!wt.path.join("b.txt").exists());
        let st = status(&wt).unwrap();
        assert!(!st.dirty && st.commits == 0);
    }
}
