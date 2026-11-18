//! Settings per repository, kept in `<state dir>/repos.json` (shared by development and installed builds):
//! what to prepare in a new worktree (files to copy, a setup script) and which tool kinds are always allowed.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoSettings {
    /// A shell script run in every new worktree before the agent starts (`npm install`, for example)
    pub setup: String,
    /// Files and folders copied from the repository into every new worktree, relative to its root (`.env`, for
    /// example: files git does not track, so a worktree does not have them)
    pub copy: Vec<String>,
    /// Kinds of tool calls answered with "allow" without asking: "read", "edit", "execute", "fetch"
    pub allow: Vec<String>,
}

impl RepoSettings {
    pub fn is_empty(&self) -> bool {
        self.setup.trim().is_empty() && self.copy.is_empty() && self.allow.is_empty()
    }

    /// Whether a permission request for this tool kind is allowed without asking
    pub fn allows(&self, kind: Option<&str>) -> bool {
        let group = match kind {
            Some("read" | "search") => "read",
            Some("edit" | "delete" | "move") => "edit",
            Some("execute") => "execute",
            Some("fetch") => "fetch",
            _ => return false,
        };
        self.allow.iter().any(|a| a == group)
    }
}

pub(crate) struct Repos {
    path: PathBuf,
}

impl Repos {
    pub(crate) fn new(state_dir: &Path) -> Self {
        Self { path: state_dir.join("repos.json") }
    }

    pub(crate) fn all(&self) -> BTreeMap<String, RepoSettings> {
        std::fs::read_to_string(&self.path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub(crate) fn get(&self, repo: &str) -> RepoSettings {
        let mut all = self.all();
        match key_for(&all, repo) {
            Some(k) => all.remove(&k).unwrap_or_default(),
            None => RepoSettings::default(),
        }
    }

    pub(crate) fn set(&self, repo: &str, settings: RepoSettings) -> std::io::Result<()> {
        let mut all = self.all();
        // The same folder written another way (separators, a link, Windows' \\?\ form) is one entry
        if let Some(k) = key_for(&all, repo) {
            all.remove(&k);
        }
        if settings.is_empty() {
            all.remove(repo);
        } else {
            all.insert(repo.to_string(), settings);
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&all).map_err(std::io::Error::other)?)?;
        std::fs::rename(tmp, &self.path)
    }
}

/// The stored key naming the same folder as `repo`: the same text, or the same folder once both are resolved
fn key_for(all: &BTreeMap<String, RepoSettings>, repo: &str) -> Option<String> {
    if all.contains_key(repo) {
        return Some(repo.to_string());
    }
    let want = std::fs::canonicalize(repo).ok()?;
    all.keys().find(|k| std::fs::canonicalize(k).is_ok_and(|p| p == want)).cloned()
}

/// A relative path that stays inside the folder it is joined to
fn inside(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel.trim());
    (!rel.trim().is_empty() && p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))).then(|| p.to_path_buf())
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(d) = to.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Copy the listed files from the repository into the worktree (ones that exist and the worktree lacks).
/// Returns the ones copied, and the problems
pub(crate) fn copy_files(repo: &Path, worktree: &Path, list: &[String]) -> (Vec<String>, Vec<String>) {
    let (mut done, mut problems) = (Vec::new(), Vec::new());
    for rel in list {
        let Some(p) = inside(rel) else {
            problems.push(format!("{rel}: not a path inside the repository"));
            continue;
        };
        let (from, to) = (repo.join(&p), worktree.join(&p));
        if !from.exists() || to.exists() {
            continue;
        }
        match copy_tree(&from, &to) {
            Ok(()) => done.push(rel.trim().to_string()),
            Err(e) => problems.push(format!("{rel}: {e}")),
        }
    }
    (done, problems)
}

pub(crate) struct SetupRun {
    pub ok: bool,
    pub elapsed: Duration,
    /// The last lines of the output (stdout and stderr together)
    pub tail: String,
    pub timed_out: bool,
}

const SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Run the setup script in the worktree, in the user's login shell (so tools installed through a version manager
/// are on PATH). Blocking: call it from spawn_blocking
pub(crate) fn run_setup(script: &str, worktree: &Path, repo: &Path, log: &Path) -> std::io::Result<SetupRun> {
    let mut cmd = shell(script);
    if let Some(d) = log.parent() {
        std::fs::create_dir_all(d)?;
    }
    let out = std::fs::File::create(log)?;
    cmd.current_dir(worktree).env("PLYFOLD_REPO", repo).env("PLYFOLD_WORKTREE", worktree).stdin(Stdio::null()).stdout(out.try_clone()?).stderr(out);
    let started = Instant::now();
    let mut child = cmd.spawn()?;
    let (status, timed_out) = loop {
        if let Some(s) = child.try_wait()? {
            break (Some(s), false);
        }
        if started.elapsed() > SETUP_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines[lines.len().saturating_sub(20)..].join("\n");
    Ok(SetupRun { ok: status.is_some_and(|s| s.success()), elapsed: started.elapsed(), tail, timed_out })
}

#[cfg(not(windows))]
fn shell(script: &str) -> Command {
    let sh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut c = Command::new(sh);
    c.arg("-lc").arg(script);
    c
}

#[cfg(windows)]
fn shell(script: &str) -> Command {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = Command::new("cmd");
    c.arg("/C").arg(script).creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-repos-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn settings_round_trip_and_empty_ones_are_dropped() {
        let d = tmp("store");
        let repos = Repos::new(&d);
        let s = RepoSettings { setup: "npm install".into(), copy: vec![".env".into()], allow: vec!["read".into()] };
        repos.set("/r", s.clone()).unwrap();
        assert_eq!(repos.get("/r"), s);
        repos.set("/r", RepoSettings::default()).unwrap();
        assert!(repos.all().is_empty());
    }

    #[test]
    fn the_same_folder_written_another_way_is_one_entry() {
        let d = tmp("alias");
        let repo = d.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repos = Repos::new(&d);
        let s = RepoSettings { setup: "make".into(), ..Default::default() };
        repos.set(&repo.display().to_string(), s.clone()).unwrap();
        let other = d.join(".").join("repo").display().to_string();
        assert_eq!(repos.get(&other), s);
        repos.set(&other, RepoSettings { setup: "make all".into(), ..Default::default() }).unwrap();
        assert_eq!(repos.all().len(), 1);
    }

    #[test]
    fn allow_groups_tool_kinds() {
        let s = RepoSettings { allow: vec!["read".into(), "execute".into()], ..Default::default() };
        assert!(s.allows(Some("read")) && s.allows(Some("search")) && s.allows(Some("execute")));
        assert!(!s.allows(Some("edit")) && !s.allows(Some("fetch")) && !s.allows(None) && !s.allows(Some("other")) && !s.allows(Some("think")));
    }

    #[test]
    fn copies_listed_files_that_stay_inside() {
        let (repo, wt) = (tmp("copy-repo"), tmp("copy-wt"));
        std::fs::write(repo.join(".env"), "A=1").unwrap();
        std::fs::create_dir_all(repo.join("conf/local")).unwrap();
        std::fs::write(repo.join("conf/local/x.toml"), "x").unwrap();
        std::fs::write(wt.join("kept.txt"), "mine").unwrap();
        std::fs::write(repo.join("kept.txt"), "theirs").unwrap();
        let list = [".env", "conf/local", "kept.txt", "missing", "../outside", "/etc/passwd"].map(String::from);
        let (done, problems) = copy_files(&repo, &wt, &list);
        assert_eq!(done, [".env", "conf/local"]);
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert_eq!(std::fs::read_to_string(wt.join("conf/local/x.toml")).unwrap(), "x");
        // A file the worktree already has is left alone
        assert_eq!(std::fs::read_to_string(wt.join("kept.txt")).unwrap(), "mine");
    }

    #[cfg(not(windows))]
    #[test]
    fn setup_runs_in_the_worktree_and_reports_failure() {
        let (repo, wt) = (tmp("setup-repo"), tmp("setup-wt"));
        let log = wt.join("log/setup.log");
        let ok = run_setup("pwd; echo \"$PLYFOLD_REPO\" > from.txt", &wt, &repo, &log).unwrap();
        assert!(ok.ok, "{}", ok.tail);
        assert_eq!(std::fs::read_to_string(wt.join("from.txt")).unwrap().trim(), repo.display().to_string());
        let bad = run_setup("echo broken >&2; exit 3", &wt, &repo, &log).unwrap();
        assert!(!bad.ok && !bad.timed_out);
        assert!(bad.tail.contains("broken"));
    }
}
