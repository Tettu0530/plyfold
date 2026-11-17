//! The changes view for a session working in the repository itself: its uncommitted changes against HEAD

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Engine, EngineOptions, StartSession};
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
