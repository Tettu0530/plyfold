//! The changes view for a session working in the repository itself: its uncommitted changes against HEAD

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Engine, EngineEvent, EngineOptions, StartSession};
use plyfold_profile::{Config, MemoryStore};

fn mock_agent() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let ok = Command::new(env!("CARGO")).args(["build", "-q", "-p", "plyfold-acp", "--bin", "plyfold-mock-agent"]).status().unwrap().success();
        assert!(ok, "failed to build the mock agent");
        let target = std::env::var("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
        let exe = target.join(format!("debug/plyfold-mock-agent{}", std::env::consts::EXE_SUFFIX));
        real(&exe)
    })
    .clone()
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("plyfold-diff-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    real(&d)
}

/// The path with symlinks resolved on macOS (/var → /private/var); Windows paths are used as they are, since
/// canonicalizing there adds a \\?\ prefix that git and the agents don't expect
fn real(p: &Path) -> PathBuf {
    assert!(p.exists(), "{} is missing", p.display());
    if cfg!(windows) { p.to_path_buf() } else { p.canonicalize().unwrap() }
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"]).args(args).current_dir(dir).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn engine(state: &Path) -> Engine {
    let toml = format!(
        r#"
[agents.mock]
# A literal string, so Windows backslashes stay as they are
command = '{}'
"#,
        mock_agent().display()
    );
    Engine::open(EngineOptions {
        state_dir: state.to_path_buf(),
        data_dir: None,
        config: Config::from_toml(&toml).unwrap(),
        secrets: Arc::new(MemoryStore::default()),
        stall_after: Duration::from_secs(60),
    })
    .unwrap()
}

#[tokio::test]
async fn a_session_in_place_shows_its_uncommitted_changes() {
    let base = tmp("inplace");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);

    let eng = engine(&base.join("state"));
    let s = eng.start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: repo.clone(), worktree: false }).await.unwrap();
    assert!(eng.diff(&s.id).unwrap().files.is_empty());

    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo.join("new.txt"), "new\n").unwrap();
    let d = eng.diff(&s.id).unwrap();
    let paths: Vec<_> = d.files.iter().map(|f| (f.path.as_str(), f.added, f.untracked)).collect();
    assert_eq!(paths, vec![("a.txt", 1, false), ("new.txt", 1, true)]);
    // Worktree operations stay with worktree sessions
    assert!(eng.worktree_status(&s.id).is_err());
    eng.close_session(&s.id).await.unwrap();
}

#[tokio::test]
async fn git_info_after_the_worktree_is_cleaned_up() {
    let base = tmp("cleanup");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);
    // Plyfold commits with the repository's identity; CI machines have none of their own
    git(&repo, &["config", "user.name", "t"]);
    git(&repo, &["config", "user.email", "t@example.invalid"]);

    let eng = engine(&base.join("state"));
    let s = eng.start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: repo.clone(), worktree: true }).await.unwrap();
    let wt = std::path::PathBuf::from(s.worktree_path.clone().unwrap());
    std::fs::write(wt.join("b.txt"), "two\n").unwrap();
    eng.close_session(&s.id).await.unwrap();
    eng.commit(&s.id, "add b").unwrap();
    eng.merge(&s.id).unwrap();
    assert!(eng.cleanup_worktree(&s.id).await.unwrap());
    let rec = eng.store().get_session(&s.id).unwrap();
    println!("after cleanup: repo={:?} worktree={:?} branch={:?}", rec.repo_path, rec.worktree_path, rec.branch);
    let info = eng.git_info(&s.id);
    println!("git_info: {:?}", info.as_ref().map(|i| (&i.branch, &i.base, i.ahead_base)).map_err(|e| e.to_string()));
    let diff = eng.diff(&s.id);
    println!("diff: {:?}", diff.as_ref().map(|d| d.files.len()).map_err(|e| e.to_string()));
    assert!(info.is_ok() && diff.is_ok());
}

#[tokio::test]
async fn a_worktree_removed_outside_plyfold_falls_back_to_the_repository() {
    let base = tmp("gone");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);

    let eng = engine(&base.join("state"));
    let mut rx = eng.subscribe();
    let s = eng.start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: repo.clone(), worktree: true }).await.unwrap();
    eng.close_session(&s.id).await.unwrap();
    // Removed by hand (or by the agent), not through Plyfold
    let wt = s.worktree_path.clone().unwrap();
    git(&repo, &["worktree", "remove", "--force", &wt]);

    let info = eng.git_info(&s.id).unwrap();
    assert_eq!(info.branch.as_deref(), Some("main"));
    let rec = eng.store().get_session(&s.id).unwrap();
    assert_eq!(rec.worktree_path, None);
    assert_eq!(rec.repo_path, s.repo_path);
    assert!(eng.diff(&s.id).unwrap().files.is_empty());
    assert!(eng.store().events(&s.id, None, 1000).unwrap().iter().any(|e| e.payload.contains("が見つからないので")));
    let changed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Ok(EngineEvent::WorkspaceChanged { session }) = rx.recv().await {
                return session;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(changed.worktree_path, None);
    // Reopening runs in the repository instead of the missing folder
    eng.reopen_session(&s.id).await.unwrap();
    eng.close_session(&s.id).await.unwrap();
}

#[tokio::test]
async fn a_worktree_deleted_from_inside_does_not_move_the_session_to_the_repository() {
    let base = tmp("deleted");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);

    let eng = engine(&base.join("state"));
    let s = eng.start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: repo.clone(), worktree: true }).await.unwrap();
    eng.close_session(&s.id).await.unwrap();
    // The folder goes, but git still lists the worktree (as when the agent deletes its own folder)
    std::fs::remove_dir_all(s.worktree_path.as_deref().unwrap()).unwrap();

    assert!(eng.git_info(&s.id).is_err());
    assert!(eng.reopen_session(&s.id).await.is_err());
    let rec = eng.store().get_session(&s.id).unwrap();
    assert_eq!(rec.worktree_path, s.worktree_path, "still the worktree session it was");
}
