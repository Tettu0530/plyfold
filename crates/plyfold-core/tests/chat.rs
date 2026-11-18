//! Everyday conversations: no repository, a folder of their own, looking things up allowed, edits declined

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Engine, EngineEvent, EngineOptions};
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
    let d = std::env::temp_dir().join(format!("plyfold-chat-{name}-{}", std::process::id()));
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
async fn a_conversation_looks_things_up_but_does_not_edit() {
    let base = tmp("chat");
    let state = base.join("state");
    let eng = engine(&state);
    let mut rx = eng.subscribe();
    let c = eng.start_chat("mock", "Talk").await.unwrap();
    assert!(c.chat);
    assert_eq!(c.worktree_path, None);
    let dir = PathBuf::from(c.repo_path.clone().unwrap());
    assert!(dir.starts_with(&state) && dir.is_dir(), "its own folder under the state directory");
    // The mock has default, plan and auto: a conversation runs in the one that asks
    let info = eng.session_info(&c.id).unwrap();
    assert_eq!(info.option(plyfold_core::Category::Mode).and_then(|o| o.current.as_deref()), Some("default"));

    // The mode stays: one that acts without asking would get past the policy
    assert!(matches!(eng.set_by_category(&c.id, plyfold_core::Category::Mode, "auto").await, Err(plyfold_core::CoreError::ModeLocked)));

    // A fetch is allowed without asking
    eng.prompt(&c.id, "permission fetch").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { session_id, .. } if session_id == &c.id)).await;
    let events = eng.store().events(&c.id, None, 10_000).unwrap();
    assert!(events.iter().any(|e| e.payload.contains("fetched the page")));
    assert!(!events.iter().any(|e| e.kind == plyfold_store::EventKind::Status && e.payload == "awaiting_permission"));

    // An edit is declined
    eng.prompt(&c.id, "permission please").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { session_id, .. } if session_id == &c.id)).await;
    assert!(!dir.join("mock-output.txt").exists());
    let events = eng.store().events(&c.id, None, 10_000).unwrap();
    assert!(events.iter().any(|e| e.payload.contains("permission rejected")));
    assert!(events.iter().any(|e| e.payload.contains("会話ではファイルの編集とコマンドを使わない")));

    // Reading inside its own folder is allowed; outside it, a command labelled as a read, or an answer that would allow
    // from now on, is not
    for (prompt, allowed) in
        [("permission read", true), ("permission read outside", false), ("permission read with-command", false), ("permission fetch always-only", false)]
    {
        let before = eng.store().events(&c.id, None, 100_000).unwrap().len();
        eng.prompt(&c.id, prompt).unwrap();
        wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { session_id, .. } if session_id == &c.id)).await;
        let events = eng.store().events(&c.id, None, 100_000).unwrap();
        let turn = &events[before..];
        let ran = turn.iter().any(|e| e.payload.contains("read the notes") || e.payload.contains("fetched the page"));
        assert_eq!(ran, allowed, "{prompt}");
        // Plyfold's answer (not the agent's list of options)
        assert!(!turn.iter().any(|e| e.payload.contains("\"selected\"") && e.payload.contains("\"optionId\":\"always\"")), "{prompt}: allowed from now on");
    }

    // Reopening works even if the folder went missing; deleting removes it
    eng.close_session(&c.id).await.unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    eng.reopen_session(&c.id).await.unwrap();
    assert!(dir.is_dir());
    eng.delete_session(&c.id, false).await.unwrap();
    assert!(!dir.exists());
}
