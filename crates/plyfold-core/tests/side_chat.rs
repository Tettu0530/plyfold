//! Side chats: a read-only fork beside a session, opened even while it works, deleted when closed

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Category, CoreError, Engine, EngineEvent, EngineOptions, StartSession, Status};
use plyfold_profile::{Config, MemoryStore};
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
    let d = std::env::temp_dir().join(format!("plyfold-side-{name}-{}", std::process::id()));
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
async fn side_chat_reads_beside_a_working_session_and_leaves_no_trace() {
    let base = tmp("side");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);

    let eng = engine(&base.join("state"));
    let mut rx = eng.subscribe();
    let main = eng.start_session(StartSession { profile: "mock".into(), title: "main".into(), repo: repo.clone(), worktree: true }).await.unwrap();
    eng.prompt(&main.id, "hello main").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
    wait_for(&mut rx, |e| matches!(e, EngineEvent::Status { status: Status::Idle, .. })).await;

    // Opened while the main session is in a turn, in the same worktree
    eng.prompt(&main.id, "hang").unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let side = eng.open_side_chat(&main.id).await.unwrap();
    assert_eq!(side.side_of.as_deref(), Some(main.id.as_str()));
    assert_eq!(side.worktree_path, main.worktree_path);
    assert_ne!(side.acp_session_id, main.acp_session_id);
    let info = eng.session_info(&side.id).unwrap();
    assert_eq!(info.option(Category::Mode).and_then(|o| o.current.as_deref()), Some("plan"), "a read-only mode is chosen");
    assert!(matches!(eng.open_side_chat(&side.id).await, Err(CoreError::NoConversation(_))), "no side chat of a side chat");

    // Permission requests are declined without asking; the main conversation does not see the side question
    eng.prompt(&side.id, "permission please").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { session_id, .. } if session_id == &side.id)).await;
    let wt = PathBuf::from(side.worktree_path.clone().unwrap());
    assert!(!wt.join("mock-output.txt").exists(), "the side chat must not write");
    let side_events = eng.store().events(&side.id, None, 10_000).unwrap();
    assert!(side_events.iter().any(|e| e.payload.contains("permission rejected")));
    assert!(side_events.iter().any(|e| e.payload.contains("サイドチャットは読み取りだけなので")));
    assert!(!eng.store().events(&main.id, None, 10_000).unwrap().iter().any(|e| e.payload.contains("permission please")));

    // A read-only side chat does not block discarding the main worktree's changes
    eng.cancel(&main.id).await.unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { session_id, .. } if session_id == &main.id)).await;
    wait_for(&mut rx, |e| matches!(e, EngineEvent::Status { session_id, status: Status::Idle } if session_id == &main.id)).await;
    eng.discard(&main.id).unwrap();

    // Closing deletes it, and its conversation is not offered as a CLI conversation
    let side_acp = side.acp_session_id.clone().unwrap();
    eng.close_side_chat(&side.id).await.unwrap();
    assert!(eng.store().get_session(&side.id).is_err());
    assert!(eng.store().dismissed_conversations().unwrap().contains(&side_acp));
    assert!(matches!(eng.close_side_chat(&main.id).await, Err(CoreError::NoConversation(_))), "only side chats close this way");

    // Deleting the main session takes its side chats with it
    let side2 = eng.open_side_chat(&main.id).await.unwrap();
    eng.delete_session(&main.id, true).await.unwrap();
    assert!(eng.store().get_session(&side2.id).is_err());
    assert!(!wt.exists());
}

#[tokio::test]
async fn side_chats_do_not_outlive_the_app() {
    let base = tmp("restart");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);

    let side = {
        let eng = engine(&base.join("state"));
        let mut rx = eng.subscribe();
        let main = eng.start_session(StartSession { profile: "mock".into(), title: "main".into(), repo: repo.clone(), worktree: false }).await.unwrap();
        eng.prompt(&main.id, "hello").unwrap();
        wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
        let side = eng.open_side_chat(&main.id).await.unwrap();
        eng.close_session(&side.id).await.unwrap();
        eng.close_session(&main.id).await.unwrap();
        side
    };
    let eng = engine(&base.join("state"));
    assert!(eng.store().get_session(&side.id).is_err());
    assert!(eng.store().dismissed_conversations().unwrap().contains(side.acp_session_id.as_ref().unwrap()));
    assert_eq!(eng.store().list_sessions().unwrap().len(), 1);
}
