//! Forking a session (new worktree, or the same workspace once the source agent has stopped)

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
    let d = std::env::temp_dir().join(format!("plyfold-fork-{name}-{}", std::process::id()));
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
async fn fork_keeps_the_conversation_and_leaves_uncommitted_files_behind() {
    let base = tmp("fork");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);

    let eng = engine(&base.join("state"));
    let mut rx = eng.subscribe();
    let src = eng.start_session(StartSession { profile: "mock".into(), title: "notes".into(), repo: repo.clone(), worktree: true }).await.unwrap();
    let src_wt = PathBuf::from(src.worktree_path.clone().unwrap());
    eng.prompt(&src.id, "hello fork").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
    wait_for(&mut rx, |e| matches!(e, EngineEvent::Status { status: Status::Idle, .. })).await;

    // Two agents must not share a directory
    assert!(matches!(eng.fork_session(&src.id, false).await, Err(CoreError::SharedWorkspace(_))));

    eng.prompt(&src.id, "hang").unwrap();
    assert!(matches!(eng.fork_session(&src.id, true).await, Err(CoreError::Busy(_))));
    // Let the mock enter its hang loop before cancelling (it clears the cancel flag when a prompt starts)
    tokio::time::sleep(Duration::from_millis(200)).await;
    eng.cancel(&src.id).await.unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
    wait_for(&mut rx, |e| matches!(e, EngineEvent::Status { status: Status::Idle, .. })).await;

    std::fs::write(src_wt.join("dirty.txt"), "not committed\n").unwrap();
    eng.close_session(&src.id).await.unwrap();

    let forked = eng.fork_session(&src.id, true).await.unwrap();
    assert_ne!(forked.id, src.id);
    assert_ne!(forked.worktree_path, src.worktree_path);
    assert_ne!(forked.acp_session_id, src.acp_session_id);
    assert_eq!(forked.status, Status::Idle);
    assert!(forked.title.contains("notes"));
    let fork_wt = PathBuf::from(forked.worktree_path.clone().unwrap());
    assert!(fork_wt.join("a.txt").exists());
    assert!(!fork_wt.join("dirty.txt").exists(), "uncommitted files stay in the source worktree");

    let copied = eng.store().events(&forked.id, None, 10_000).unwrap();
    assert!(copied.iter().any(|e| e.kind == EventKind::ForkOut && e.payload.contains("hello fork")));
    assert!(copied.iter().any(|e| e.payload.contains("新しい worktree で分岐しました")));
    let turns = eng.store().usage_events(0).unwrap().into_iter().filter(|e| e.kind == EventKind::FrameOut).count();
    assert_eq!(turns, 2, "the copied prompt is not counted again");

    // Once the source agent is stopped, the same workspace is allowed
    let shared = eng.fork_session(&src.id, false).await.unwrap();
    assert_eq!(shared.worktree_path, src.worktree_path);
    assert_eq!(shared.branch, src.branch);
    assert!(matches!(eng.fork_session(&src.id, false).await, Err(CoreError::SharedWorkspace(_))));
    assert!(eng.store().events(&shared.id, None, 100).unwrap().iter().any(|e| e.payload.contains("同じ作業場所で分岐しました")));

    // Deleting, cleaning up or discarding one session must not wipe the worktree the other still uses
    std::fs::write(src_wt.join("keep.txt"), "shared\n").unwrap();
    assert!(matches!(eng.discard(&src.id), Err(CoreError::SharedWorktree)));
    assert!(src_wt.join("keep.txt").exists());
    assert!(!eng.cleanup_worktree(&src.id).await.unwrap());
    assert!(src_wt.join("keep.txt").exists());
    assert_eq!(eng.store().get_session(&src.id).unwrap().worktree_path.as_deref(), src.worktree_path.as_deref());
    eng.delete_session(&src.id, true).await.unwrap();
    assert!(src_wt.exists());
    assert!(eng.store().events(&shared.id, None, 100).unwrap().iter().any(|e| e.payload.contains("worktree と枝は残してあります")));
    eng.delete_session(&shared.id, true).await.unwrap();
    assert!(!src_wt.exists());

    eng.prompt(&forked.id, "after").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { session_id, .. } if session_id == &forked.id)).await;
}
