//! Opening a conversation the CLI already has (session/list, then session/load in a new worktree)

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{CoreError, Engine, EngineEvent, EngineOptions, StartSession, Status};
use plyfold_profile::{Config, MemoryStore};
use plyfold_store::EventKind;
use tokio::sync::broadcast::Receiver;

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
    let d = std::env::temp_dir().join(format!("plyfold-adopt-{name}-{}", std::process::id()));
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

async fn wait_for<F: Fn(&EngineEvent) -> bool>(rx: &mut Receiver<EngineEvent>, f: F) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let e = rx.recv().await.unwrap();
            if f(&e) {
                return e;
            }
        }
    })
    .await
    .expect("no event arrived")
}

#[tokio::test]
async fn adopt_opens_a_cli_conversation_in_a_new_worktree() {
    let base = tmp("adopt");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);

    let eng = engine(&base.join("state"));
    let mut rx = eng.subscribe();
    let src = eng.start_session(StartSession { profile: "mock".into(), title: "notes".into(), repo: repo.clone(), worktree: false }).await.unwrap();
    eng.prompt(&src.id, "remember this").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
    wait_for(&mut rx, |e| matches!(e, EngineEvent::Status { status: Status::Idle, .. })).await;
    eng.close_session(&src.id).await.unwrap();

    // Plyfold already has this conversation, so the list hides it
    assert!(eng.list_cli_sessions("mock", &repo).await.unwrap().is_empty());
    let acp = src.acp_session_id.clone().unwrap();
    eng.delete_session(&src.id, false).await.unwrap();
    std::fs::write(repo.join("dirty.txt"), "not committed\n").unwrap();

    let listed = eng.list_cli_sessions("mock", &repo).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].acp_session_id, acp);
    assert_eq!(listed[0].title.as_deref(), Some("remember this"));

    let opened = eng.adopt_session("mock", &repo, &acp, listed[0].title.as_deref().unwrap()).await.unwrap();
    assert_ne!(opened.id, src.id);
    assert_eq!(opened.acp_session_id.as_deref(), Some(acp.as_str()));
    assert_eq!(opened.status, Status::Idle);
    let wt = PathBuf::from(opened.worktree_path.clone().unwrap());
    assert_ne!(wt, repo);
    assert!(wt.join("a.txt").exists());
    assert!(!wt.join("dirty.txt").exists(), "uncommitted files stay in the original directory");
    let copied = eng.store().events(&opened.id, None, 10_000).unwrap();
    assert!(copied.iter().any(|e| e.kind == EventKind::ForkIn && e.payload.contains("remember this")));
    assert!(copied.iter().any(|e| e.payload.contains("新しい worktree で開きました")));
    assert!(eng.store().usage_events(0).unwrap().is_empty(), "the resent history is not new usage");
    assert!(eng.list_cli_sessions("mock", &repo).await.unwrap().is_empty());
    assert!(matches!(eng.adopt_session("mock", &repo, &acp, "again").await, Err(CoreError::AlreadyInPlyfold)));
}
