//! A profile whose key hits a rate or usage limit hands the session to its fallback, which gets the prompt again

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Engine, EngineEvent, EngineOptions, StartSession};
use plyfold_profile::{Config, MemoryStore};
use tokio::sync::broadcast::Receiver;

fn mock_agent() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let ok = Command::new(env!("CARGO")).args(["build", "-q", "-p", "plyfold-acp", "--bin", "plyfold-mock-agent"]).status().unwrap().success();
        assert!(ok, "failed to build the mock agent");
        let target = std::env::var("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
        real(&target.join(format!("debug/plyfold-mock-agent{}", std::env::consts::EXE_SUFFIX)))
    })
    .clone()
}

fn real(p: &Path) -> PathBuf {
    assert!(p.exists(), "{} is missing", p.display());
    if cfg!(windows) { p.to_path_buf() } else { p.canonicalize().unwrap() }
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("plyfold-fallback-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    real(&d)
}

async fn turn_ended(rx: &mut Receiver<EngineEvent>, id: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let EngineEvent::TurnEnded { session_id, .. } = rx.recv().await.unwrap()
                && session_id == id
            {
                return;
            }
        }
    })
    .await
    .expect("the turn did not end");
}

#[tokio::test]
async fn a_limited_key_hands_the_session_to_its_fallback() {
    let base = tmp("switch");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let toml = format!(
        r#"
[agents.mock]
command = '{}'
[profiles.first]
agent = "mock"
fallback = "second"
[profiles.first.env]
MOCK_LIMITED = "1"
[profiles.second]
agent = "mock"
fallback = "first"
"#,
        mock_agent().display()
    );
    let eng = Engine::open(EngineOptions {
        state_dir: base.join("state"),
        data_dir: None,
        config: Config::from_toml(&toml).unwrap(),
        secrets: Arc::new(MemoryStore::default()),
        stall_after: Duration::from_secs(60),
    })
    .unwrap();
    let mut rx = eng.subscribe();
    let s = eng.start_session(StartSession { profile: "first".into(), title: "Work".into(), repo: repo.clone(), worktree: false }).await.unwrap();

    // A plain answer about limits does not switch
    eng.prompt(&s.id, "hello").unwrap();
    turn_ended(&mut rx, &s.id).await;
    assert_eq!(eng.store().get_session(&s.id).unwrap().profile, "first");

    // The first key is limited: the session moves to the second and the prompt is answered there
    eng.prompt(&s.id, "limit me").unwrap();
    turn_ended(&mut rx, &s.id).await; // the limited turn
    turn_ended(&mut rx, &s.id).await; // the same prompt, sent again with the second key
    let rec = eng.store().get_session(&s.id).unwrap();
    assert_eq!(rec.profile, "second");
    let events = eng.store().events(&s.id, None, 10_000).unwrap();
    assert!(events.iter().any(|e| e.payload.contains("rate_limit_error")));
    assert!(events.iter().any(|e| e.payload.contains("echo: limit me")), "answered with the second key");
    assert!(events.iter().any(|e| e.payload.contains("first のキーが上限に達した") || e.payload.contains("first's key hit its limit")));
    eng.close_session(&s.id).await.unwrap();
}
