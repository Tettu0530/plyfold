//! Branch, commits and the remote for a session's working directory (a worktree or the repository itself):
//! where the branch stands against its base and its upstream, recent commits, and fetch / push / pull / PR status.
//!
//! - Network commands never wait for input: no terminal prompts (`GIT_TERMINAL_PROMPT=0`, stdin closed) and a time
//!   limit, so a missing credential fails instead of hanging the app
//! - Remote URLs are shown without any user name or token they may contain

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::WorktreeError;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_COMMITS: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// Unix seconds
    pub time: i64,
    /// Already on the upstream branch
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct GitInfo {
    /// Current branch (None for a detached HEAD)
    pub branch: Option<String>,
    /// What the branch is compared with (the branch it will be merged into, e.g. "main")
    pub base: Option<String>,
    pub ahead_base: u32,
    pub behind_base: u32,
    /// Upstream branch ("origin/plyfold/…"); None until the branch is pushed
    pub upstream: Option<String>,
    /// The upstream the branch was pushed to, when it has since been deleted on the remote (typically after its pull
    /// request was merged). Its commits are then not counted as unpushed
    pub upstream_gone: Option<String>,
    /// Against the upstream, as of the last fetch
    pub ahead: u32,
    pub behind: u32,
    /// Files with uncommitted changes (including untracked)
    pub changed: u32,
    /// Commits on the branch that are not in the base (newest first). Without a base, the latest few
    pub commits: Vec<Commit>,
    /// The origin remote's URL without credentials
    pub remote_url: Option<String>,
    /// Web page of the repository (GitHub and similar hosts), for links
    pub web_url: Option<String>,
    /// When the remote was last fetched (unix seconds)
    pub fetched_at: Option<i64>,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let out = crate::git_command().args(args).current_dir(dir).stdin(Stdio::null()).output()?;
    if !out.status.success() {
        return Err(WorktreeError::Git { args: args.join(" "), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Run a command that may talk to the network: no prompts, and killed after the time limit
fn run_network(program: &str, dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let mut cmd = if program == "git" { crate::git_command() } else { crate::command(program) };
    let mut child = cmd
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if started.elapsed() > NETWORK_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(WorktreeError::Op(plyfold_i18n::tr!(
                "{program} {} が {} 秒たっても終わらないので止めました",
                "Stopped {program} {} after {} seconds",
                "{program} {} 超过 {} 秒未结束，已停止",
                args.first().copied().unwrap_or(""),
                NETWORK_TIMEOUT.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut out = String::new();
    let mut err = String::new();
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_string(&mut out);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    if !status.success() {
        return Err(WorktreeError::Git { args: format!("{program} {}", args.join(" ")), stderr: redact(err.trim()) });
    }
    Ok(out)
}

/// Remove "user:token@" from URLs (in remote URLs and in error messages that quote them)
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c.is_whitespace() || c == '/' || c == '\'' || c == '"').unwrap_or(tail.len());
        let host = &tail[..end];
        out.push_str(host.rsplit_once('@').map_or(host, |(_, h)| h));
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// https page for a remote URL on a web host (git@github.com:owner/repo.git → https://github.com/owner/repo)
pub fn web_url(remote: &str) -> Option<String> {
    let r = redact(remote.trim());
    let (host, path) = if let Some(rest) = r.strip_prefix("git@") {
        rest.split_once(':')?
    } else if let Some(rest) = r.strip_prefix("ssh://") {
        let rest = rest.rsplit_once('@').map_or(rest, |(_, h)| h);
        let (host, path) = rest.split_once('/')?;
        (host.split(':').next().unwrap_or(host), path)
    } else {
        r.strip_prefix("https://").or_else(|| r.strip_prefix("http://"))?.split_once('/')?
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    (!host.is_empty() && path.contains('/')).then(|| format!("https://{host}/{path}"))
}

/// The remote's default branch as a ref ("origin/main"), if known locally
pub fn remote_default(dir: &Path) -> Option<String> {
    git(dir, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn counts(dir: &Path, range: &str) -> (u32, u32) {
    git(dir, &["rev-list", "--left-right", "--count", range])
        .ok()
        .and_then(|s| {
            let mut it = s.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
            Some((it.next()?, it.next()?))
        })
        .unwrap_or((0, 0))
}

/// Where the branch stands. `base` is the branch it is compared with (None: compare with nothing, list recent commits)
pub fn info(dir: &Path, base: Option<&str>) -> Result<GitInfo, WorktreeError> {
    git(dir, &["rev-parse", "--git-dir"]).map_err(|_| WorktreeError::NotARepo(dir.to_path_buf()))?;
    let branch = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let upstream = git(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    // A configured upstream whose remote branch is gone ("[gone]"): it was pushed, then deleted on the remote
    let upstream_gone = match (&upstream, &branch) {
        (None, Some(b)) => git(dir, &["for-each-ref", "--format=%(upstream:short)%00%(upstream:track)", &format!("refs/heads/{b}")]).ok().and_then(|s| {
            let (name, track) = s.trim().split_once('\0')?;
            (track.contains("gone") && !name.is_empty()).then(|| name.to_string())
        }),
        _ => None,
    };
    // A base that is the branch itself or its own upstream says nothing new
    let base = base.filter(|b| Some(*b) != branch.as_deref() && Some(*b) != upstream.as_deref() && git(dir, &["rev-parse", "--verify", "--quiet", b]).is_ok());
    let (behind_base, ahead_base) = base.map_or((0, 0), |b| counts(dir, &format!("{b}...HEAD")));
    let (behind, ahead) = upstream.as_deref().map_or((0, 0), |u| counts(dir, &format!("{u}...HEAD")));
    let changed = git(dir, &["status", "--porcelain"]).map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32).unwrap_or(0);

    let range = base.map(|b| format!("{b}..HEAD"));
    let max = format!("--max-count={}", if base.is_some() { MAX_COMMITS } else { 10 });
    let mut args = vec!["log", "--format=%h%x1f%s%x1f%an%x1f%ct", max.as_str()];
    if let Some(r) = range.as_deref() {
        args.push(r);
    }
    // An empty repository has no HEAD to log
    let log = git(dir, &args).unwrap_or_default();
    // Commits the upstream doesn't have yet (the first `ahead` of HEAD's history are unpushed)
    let unpushed: std::collections::HashSet<String> = match upstream.as_deref() {
        Some(u) => git(dir, &["log", "--format=%h", &format!("{u}..HEAD")]).unwrap_or_default().lines().map(str::to_string).collect(),
        None => Default::default(),
    };
    let commits = log
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\x1f');
            let sha = f.next()?.to_string();
            Some(Commit {
                // With the upstream gone, which commits it had is unknown; they are not marked
                pushed: upstream_gone.is_some() || (upstream.is_some() && !unpushed.contains(&sha)),
                sha,
                subject: f.next().unwrap_or_default().to_string(),
                author: f.next().unwrap_or_default().to_string(),
                time: f.next().and_then(|t| t.trim().parse().ok()).unwrap_or(0),
            })
        })
        .collect();

    let remote_url = git(dir, &["remote", "get-url", "origin"]).ok().map(|s| redact(s.trim())).filter(|s| !s.is_empty());
    let web = remote_url.as_deref().and_then(web_url);
    let fetched_at = git(dir, &["rev-parse", "--git-common-dir"]).ok().and_then(|d| {
        let d = Path::new(d.trim());
        let d = if d.is_absolute() { d.to_path_buf() } else { dir.join(d) };
        let modified = std::fs::metadata(d.join("FETCH_HEAD")).ok()?.modified().ok()?;
        Some(modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64)
    });
    Ok(GitInfo {
        branch,
        base: base.map(str::to_string),
        ahead_base,
        behind_base,
        upstream,
        upstream_gone,
        ahead,
        behind,
        changed,
        commits,
        remote_url,
        web_url: web,
        fetched_at,
    })
}

fn need_origin(dir: &Path) -> Result<(), WorktreeError> {
    git(dir, &["remote", "get-url", "origin"]).map(|_| ()).map_err(|_| {
        WorktreeError::Op(plyfold_i18n::tr!("このリポジトリには origin がありません", "This repository has no origin remote", "此仓库没有 origin"))
    })
}

/// Fetch from origin (updates ahead / behind)
pub fn fetch(dir: &Path) -> Result<(), WorktreeError> {
    need_origin(dir)?;
    run_network("git", dir, &["fetch", "--quiet", "--prune", "origin"]).map(|_| ())
}

/// Push the current branch to origin, setting it as the upstream the first time. Returns the upstream
pub fn push(dir: &Path) -> Result<String, WorktreeError> {
    need_origin(dir)?;
    let branch = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map(|s| s.trim().to_string()).map_err(|_| {
        WorktreeError::Op(plyfold_i18n::tr!("ブランチにいないので push できません", "Not on a branch, so there is nothing to push", "不在分支上，无法推送"))
    })?;
    // A branch named like an option ("-f") would change what push does
    if branch.starts_with('-') {
        return Err(WorktreeError::Op(plyfold_i18n::tr!(
            "ブランチ名 {branch} は - で始まるので push しません",
            "The branch {branch} starts with -, so it is not pushed",
            "分支 {branch} 以 - 开头，因此不推送"
        )));
    }
    run_network("git", dir, &["push", "--quiet", "--set-upstream", "origin", &branch])?;
    Ok(format!("origin/{branch}"))
}

/// Bring in the upstream's new commits, only when that needs no merge (fast-forward)
pub fn pull(dir: &Path) -> Result<(), WorktreeError> {
    if git(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_err() {
        return Err(WorktreeError::Op(plyfold_i18n::tr!(
            "このブランチはまだ push していないので、取ってくる先がありません",
            "This branch hasn't been pushed yet, so there is nothing to pull from",
            "此分支尚未推送，没有可拉取的来源"
        )));
    }
    run_network("git", dir, &["pull", "--quiet", "--ff-only"]).map(|_| ()).map_err(|e| {
        WorktreeError::Op(plyfold_i18n::tr!(
            "早送りで取り込めませんでした。手元とリモートの両方に新しいコミットがあるか、変更がぶつかっています。\n{e}",
            "Could not fast-forward. Both this branch and the remote have new commits, or the changes conflict.\n{e}",
            "无法快进合并。本地和远程都有新的提交，或更改存在冲突。\n{e}"
        ))
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Checks {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub title: String,
    /// "OPEN" / "MERGED" / "CLOSED"
    pub state: String,
    pub draft: bool,
    /// "APPROVED" / "CHANGES_REQUESTED" / "REVIEW_REQUIRED", when set
    pub review: Option<String>,
    pub checks: Checks,
}

pub fn has_gh() -> bool {
    crate::has_program("gh")
}

/// The pull request for the current branch (via gh). None when there is none, or gh isn't available
pub fn pull_request(dir: &Path) -> Result<Option<PullRequest>, WorktreeError> {
    if !has_gh() || git(dir, &["remote", "get-url", "origin"]).is_err() {
        return Ok(None);
    }
    let Ok(branch) = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]) else { return Ok(None) };
    let out = match run_network("gh", dir, &["pr", "view", branch.trim(), "--json", "number,url,title,state,isDraft,reviewDecision,statusCheckRollup"]) {
        Ok(o) => o,
        // "no pull requests found" (and not logged in) both mean there is nothing to show
        Err(_) => return Ok(None),
    };
    Ok(parse_pr(&out))
}

pub fn parse_pr(json: &str) -> Option<PullRequest> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut checks = Checks::default();
    for c in v["statusCheckRollup"].as_array().into_iter().flatten() {
        // Check runs have status + conclusion; commit statuses have state
        let state = c["conclusion"].as_str().filter(|s| !s.is_empty()).or_else(|| c["state"].as_str()).unwrap_or("");
        let done = c["status"].as_str().is_none_or(|s| s == "COMPLETED");
        match (done, state) {
            (false, _) | (_, "PENDING" | "EXPECTED" | "") => checks.pending += 1,
            (_, "SUCCESS" | "NEUTRAL" | "SKIPPED") => checks.passed += 1,
            _ => checks.failed += 1,
        }
    }
    Some(PullRequest {
        number: v["number"].as_u64()?,
        url: v["url"].as_str()?.to_string(),
        title: v["title"].as_str().unwrap_or_default().to_string(),
        state: v["state"].as_str().unwrap_or("OPEN").to_string(),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        review: v["reviewDecision"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::process::Command;

    #[cfg(unix)]
    fn sh(dir: &Path, cmd: &str) {
        let ok = Command::new("sh").args(["-c", cmd]).current_dir(dir).status().unwrap().success();
        assert!(ok, "{cmd}");
    }

    #[cfg(unix)]
    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "plyfold-remote-{name}-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            {
                // The clock is only microsecond-precise on macOS, so tests running in parallel need a counter too
                static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            }
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    const ID: &str = "git -c user.name=t -c user.email=t@example.com";

    #[test]
    fn strips_credentials_and_finds_web_pages() {
        assert_eq!(redact("https://me:ghp_secret@github.com/o/r.git"), "https://github.com/o/r.git");
        assert_eq!(redact("fatal: unable to access 'https://x:y@host/o/r/': 403"), "fatal: unable to access 'https://host/o/r/': 403");
        assert_eq!(redact("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(web_url("git@github.com:o/r.git").as_deref(), Some("https://github.com/o/r"));
        assert_eq!(web_url("https://tok@gitlab.com/g/s/r.git").as_deref(), Some("https://gitlab.com/g/s/r"));
        assert_eq!(web_url("ssh://git@github.com:22/o/r.git").as_deref(), Some("https://github.com/o/r"));
        assert_eq!(web_url("/local/path/repo"), None);
    }

    #[test]
    #[cfg(unix)]
    fn reads_branch_commits_and_upstream() {
        let root = temp("info");
        let origin = root.join("origin.git");
        let work = root.join("work");
        sh(&root, "git init -q --bare -b main origin.git && git init -q -b main work");
        sh(&work, &format!("git remote add origin {} && echo a > a && git add a && {ID} commit -qm first && git push -q -u origin main", origin.display()));
        sh(
            &work,
            &format!(
                "git switch -q -c topic && echo b > b && git add b && {ID} commit -qm second && echo c > c && git add c && {ID} commit -qm third && echo x > x"
            ),
        );

        let i = info(&work, Some("main")).unwrap();
        assert_eq!(i.branch.as_deref(), Some("topic"));
        assert_eq!(i.base.as_deref(), Some("main"));
        assert_eq!((i.ahead_base, i.behind_base), (2, 0));
        assert_eq!(i.upstream, None);
        assert_eq!(i.changed, 1);
        assert_eq!(i.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["third", "second"]);
        assert!(i.commits.iter().all(|c| !c.pushed));

        // After pushing, the branch tracks origin and its commits count as pushed
        assert_eq!(push(&work).unwrap(), "origin/topic");
        sh(&work, &format!("echo d > d && git add d && {ID} commit -qm fourth"));
        let i = info(&work, Some("main")).unwrap();
        assert_eq!(i.upstream.as_deref(), Some("origin/topic"));
        assert_eq!((i.ahead, i.behind), (1, 0));
        assert_eq!(i.commits.iter().map(|c| c.pushed).collect::<Vec<_>>(), [false, true, true]);
        assert!(i.fetched_at.is_none() || i.fetched_at.unwrap() > 0);

        // A base equal to the branch itself is ignored
        assert_eq!(info(&work, Some("topic")).unwrap().base, None);
        // pull fast-forwards when only the remote moved
        sh(&work, "git push -q");
        let other = root.join("other");
        sh(&root, &format!("git clone -q -b topic {} other", origin.display()));
        sh(&other, &format!("echo e > e && git add e && {ID} commit -qm fifth && git push -q"));
        fetch(&work).unwrap();
        assert_eq!(info(&work, Some("main")).unwrap().behind, 1);
        pull(&work).unwrap();
        assert_eq!(info(&work, Some("main")).unwrap().behind, 0);

        // Merged on the host and the remote branch deleted: the upstream is gone, and nothing counts as unpushed
        sh(&work, "git push -q origin --delete topic && git fetch -q --prune");
        let i = info(&work, Some("main")).unwrap();
        assert_eq!(i.upstream, None);
        assert_eq!(i.upstream_gone.as_deref(), Some("origin/topic"));
        assert!(i.ahead_base > 0);
        assert!(i.commits.iter().all(|c| c.pushed));
    }

    #[test]
    fn reads_pull_request_status() {
        let pr = parse_pr(r#"{"number":12,"url":"https://github.com/o/r/pull/12","title":"Fix","state":"OPEN","isDraft":false,"reviewDecision":"",
            "statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"IN_PROGRESS","conclusion":""},{"status":"COMPLETED","conclusion":"FAILURE"},{"state":"SUCCESS"},{"state":"PENDING"}]}"#)
        .unwrap();
        assert_eq!(pr.number, 12);
        assert_eq!(pr.review, None);
        assert_eq!(pr.checks, Checks { passed: 2, failed: 1, pending: 2 });
        assert!(parse_pr("not json").is_none());
    }
}
