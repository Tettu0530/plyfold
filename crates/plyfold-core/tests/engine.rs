//! Engine integration tests against the mock agent (no tokens spent)

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Engine, EngineEvent, EngineOptions, StartSession, Status};
use plyfold_profile::{Config, MemoryStore};
use tokio::sync::broadcast::Receiver;

/// Build the mock agent binary once and return its path
fn mock_agent() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let ok = Command::new(env!("CARGO"))
            .args(["build", "-q", "-p", "plyfold-acp", "--bin", "plyfold-mock-agent"])
            .status()
            .unwrap()
            .success();
        assert!(ok, "failed to build the mock agent");
        let target = std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
        target.join("debug/plyfold-mock-agent").canonicalize().unwrap()
    })
    .clone()
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("plyfold-core-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn git_repo(dir: &Path) {
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"],
    ] {
        assert!(Command::new("git").args(&args).current_dir(dir).status().unwrap().success());
    }
}

fn engine(state: &Path, stall_ms: u64) -> Engine {
    let toml = format!(
        r#"
[agents.mock]
command = "{}"

[profiles.mock-keyed]
agent = "mock"
keys = {{ MOCK_KEY = "keychain:mock/KEY" }}
"#,
        mock_agent().display()
    );
    Engine::open(EngineOptions {
        state_dir: state.to_path_buf(),
        config: Config::from_toml(&toml).unwrap(),
        secrets: Arc::new(MemoryStore::from([("mock/KEY", "sk-mock-secret-123456")])),
        stall_after: Duration::from_millis(stall_ms),
    })
    .unwrap()
}

async fn wait_for<F: Fn(&EngineEvent) -> bool>(rx: &mut Receiver<EngineEvent>, f: F) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(10), async {
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

fn is_status(e: &EngineEvent, want: Status) -> bool {
    matches!(e, EngineEvent::Status { status, .. } if *status == want)
}

#[tokio::test]
async fn worktree_session_with_permission_and_diff() {
    let base = tmp("perm");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git_repo(&repo);
    let eng = engine(&base.join("state"), 60_000);
    let mut rx = eng.subscribe();

    let s = eng
        .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: repo.clone(), worktree: true })
        .await
        .unwrap();
    assert_eq!(s.status, Status::Idle);
    let wt = PathBuf::from(s.worktree_path.clone().unwrap());
    assert!(wt.exists() && wt != repo);

    eng.prompt(&s.id, "write with permission").unwrap();
    let pid = match wait_for(&mut rx, |e| matches!(e, EngineEvent::PermissionRequested { .. })).await {
        EngineEvent::PermissionRequested { permission_id, options, title, .. } => {
            assert_eq!(title, "Write mock-output.txt");
            assert_eq!(options.iter().map(|o| o.kind.as_str()).collect::<Vec<_>>(), ["allow_once", "reject_once"]);
            permission_id
        }
        _ => unreachable!(),
    };
    assert_eq!(eng.store().get_session(&s.id).unwrap().status, Status::AwaitingPermission);
    eng.respond_permission(&s.id, &pid, Some("allow")).await.unwrap();
    match wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await {
        EngineEvent::TurnEnded { stop_reason, error, .. } => {
            assert_eq!(stop_reason.as_deref(), Some("end_turn"));
            assert!(error.is_none());
        }
        _ => unreachable!(),
    }
    wait_for(&mut rx, |e| is_status(e, Status::Idle)).await;

    // The diff stays inside the worktree; the original repository is untouched
    let d = eng.diff(&s.id).unwrap();
    let paths: Vec<_> = d.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"mock-output.txt"), "{paths:?}");
    assert!(!repo.join("mock-output.txt").exists());

    // Every frame sent and received is recorded
    let events = eng.store().events(&s.id, None, 10_000).unwrap();
    assert!(events.iter().any(|e| e.payload.contains("session/request_permission")));

    eng.delete_session(&s.id, true).await.unwrap();
    assert!(!wt.exists());
}

#[tokio::test]
async fn cancel_resolves_pending_permission_and_stops_turn() {
    let base = tmp("cancel");
    let eng = engine(&base.join("state"), 60_000);
    let mut rx = eng.subscribe();
    let s = eng
        .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: base.clone(), worktree: false })
        .await
        .unwrap();

    eng.prompt(&s.id, "hang").unwrap();
    assert!(matches!(eng.prompt(&s.id, "again"), Err(plyfold_core::CoreError::Busy(_))));
    tokio::time::sleep(Duration::from_millis(100)).await;
    eng.cancel(&s.id).await.unwrap();
    match wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await {
        EngineEvent::TurnEnded { stop_reason, .. } => assert_eq!(stop_reason.as_deref(), Some("cancelled")),
        _ => unreachable!(),
    }

    // Cancel while a permission request is pending → the request is answered as cancelled
    eng.prompt(&s.id, "permission").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::PermissionRequested { .. })).await;
    eng.cancel(&s.id).await.unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::PermissionResolved { option_id: None, .. })).await;
    match wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await {
        EngineEvent::TurnEnded { stop_reason, .. } => assert_eq!(stop_reason.as_deref(), Some("cancelled")),
        _ => unreachable!(),
    }
    eng.close_session(&s.id).await.unwrap();
}

#[tokio::test]
async fn stall_detection_and_recovery() {
    let base = tmp("stall");
    let eng = engine(&base.join("state"), 500);
    let mut rx = eng.subscribe();
    let s = eng
        .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: base.clone(), worktree: false })
        .await
        .unwrap();
    eng.prompt(&s.id, "silent").unwrap(); // stays silent for 3 s
    wait_for(&mut rx, |e| is_status(e, Status::Stalled)).await;
    wait_for(&mut rx, |e| is_status(e, Status::Working)).await; // recovers once something arrives
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
    eng.close_session(&s.id).await.unwrap();
}

#[tokio::test]
async fn reopen_after_close_and_restart_uses_session_load() {
    let base = tmp("reopen");
    let state = base.join("state");
    let id = {
        let eng = engine(&state, 60_000);
        let mut rx = eng.subscribe();
        let s = eng
            .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: base.clone(), worktree: false })
            .await
            .unwrap();
        eng.prompt(&s.id, "remember me").unwrap();
        wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
        s.id
        // Drop the engine (like restarting the app; the process is stopped by kill_on_drop)
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let eng = engine(&state, 60_000);
    assert_eq!(eng.store().get_session(&id).unwrap().status, Status::Closed);
    let mut rx = eng.subscribe();
    eng.reopen_session(&id).await.unwrap();
    // The history is resent
    let e = wait_for(&mut rx, |e| matches!(e, EngineEvent::Update { update, .. } if update["sessionUpdate"] == "user_message_chunk")).await;
    if let EngineEvent::Update { update, .. } = e {
        assert_eq!(update["content"]["text"], "remember me");
    }
    assert!(eng.is_running(&id));
    assert!(matches!(eng.reopen_session(&id).await, Err(plyfold_core::CoreError::AlreadyRunning(_))));
    eng.close_session(&id).await.unwrap();
}

#[tokio::test]
async fn keyed_profile_secret_is_redacted_in_log_and_launch_failure_is_reported() {
    let base = tmp("keyed");
    let eng = engine(&base.join("state"), 60_000);
    let mut rx = eng.subscribe();
    let s = eng
        .start_session(StartSession { profile: "mock-keyed".into(), title: "t".into(), repo: base.clone(), worktree: false })
        .await
        .unwrap();
    eng.prompt(&s.id, "echo sk-mock-secret-123456").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
    let all: String = eng.store().events(&s.id, None, 10_000).unwrap().into_iter().map(|e| e.payload).collect();
    assert!(!all.contains("sk-mock-secret-123456"));
    assert!(all.contains("***"));
    eng.close_session(&s.id).await.unwrap();

    // Worktree requested but not a git repository → recorded as Error
    let err = eng
        .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: base.join("nope"), worktree: true })
        .await;
    assert!(err.is_err());
    let failed = eng.store().list_sessions().unwrap().into_iter().find(|r| r.status == Status::Error).unwrap();
    assert!(eng.store().events(&failed.id, None, 100).unwrap().iter().any(|e| e.payload.contains("作業場所を用意できません")));
}

#[tokio::test]
async fn turn_end_is_delivered_after_all_updates_of_the_turn() {
    let base = tmp("order");
    let eng = engine(&base.join("state"), 60_000);
    let mut rx = eng.subscribe();
    let s = eng
        .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: base.clone(), worktree: false })
        .await
        .unwrap();
    for i in 0..30 {
        let text = format!("turn-{i}");
        eng.prompt(&s.id, &text).unwrap();
        let mut got = String::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                EngineEvent::Update { update, .. } if update["sessionUpdate"] == "agent_message_chunk" => {
                    got.push_str(update["content"]["text"].as_str().unwrap());
                }
                EngineEvent::TurnEnded { .. } => break,
                _ => {}
            }
        }
        assert_eq!(got, format!("echo: {text}"), "turn {i}: the message arrived after the turn ended");
        wait_for(&mut rx, |e| is_status(e, Status::Idle)).await;
    }
    eng.close_session(&s.id).await.unwrap();
}

#[tokio::test]
async fn session_info_config_switching_and_usage() {
    use plyfold_core::Category;
    let base = tmp("info");
    let eng = engine(&base.join("state"), 60_000);
    let mut rx = eng.subscribe();
    let s = eng
        .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: base.clone(), worktree: false })
        .await
        .unwrap();

    let info = eng.session_info(&s.id).unwrap();
    assert_eq!(info.option(Category::Model).unwrap().current.as_deref(), Some("mock-large"));
    assert_eq!(info.option(Category::ThoughtLevel).unwrap().id, "effort");

    // Switch by category (regardless of the ID)
    eng.set_by_category(&s.id, Category::ThoughtLevel, "high").await.unwrap();
    eng.set_by_category(&s.id, Category::Mode, "plan").await.unwrap();
    let info = eng.session_info(&s.id).unwrap();
    assert_eq!(info.option(Category::ThoughtLevel).unwrap().current.as_deref(), Some("high"));
    assert_eq!(info.option(Category::Mode).unwrap().current.as_deref(), Some("plan"));
    assert!(eng.set_by_category(&s.id, Category::Model, "no-such-model").await.is_err());

    // Usage is filled in after the turn. Info arrives before the turn ends
    eng.prompt(&s.id, "count my tokens please").unwrap();
    let mut saw_info_with_turn = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
            EngineEvent::Info { info, .. } if info.last_turn.is_some() => saw_info_with_turn = true,
            EngineEvent::TurnEnded { .. } => break,
            _ => {}
        }
    }
    assert!(saw_info_with_turn, "usage Info should arrive before the turn ends");
    let info = eng.session_info(&s.id).unwrap();
    let turn = info.last_turn.unwrap();
    assert_eq!(turn.usage.unwrap().input, 100);
    assert!(turn.ttft_ms.is_some());
    assert_eq!(info.context_size, Some(100_000));
    assert_eq!(info.reported_model.as_deref(), Some("mock-large-2026"));
    assert!(info.cost.is_some());
    assert_eq!(info.total.input, 100);
    eng.close_session(&s.id).await.unwrap();
}

#[tokio::test]
async fn check_profile_reports_reply_and_model() {
    let state = tmp("check");
    let engine = engine(&state, 30_000);
    let r = engine.check_profile("mock-keyed").await;
    assert!(r.ok, "{:?}", r.error);
    assert!(!r.reply.is_empty());
    assert_eq!(r.configured_model.as_deref(), Some("mock-large"));
    assert_eq!(r.reported_model.as_deref(), Some("mock-large-2026"));
    assert!(r.first_text_ms.is_some());
    // Not recorded
    assert!(engine.store().list_sessions().unwrap().is_empty());

    let bad = engine.check_profile("nope").await;
    assert!(!bad.ok && bad.error.is_some());
}

#[tokio::test]
async fn reopen_falls_back_to_new_session_when_agent_lost_the_transcript() {
    let base = tmp("reopen-lost");
    let state = base.join("state");
    let eng = engine(&state, 60_000);
    let mut rx = eng.subscribe();
    let s = eng
        .start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: base.clone(), worktree: false })
        .await
        .unwrap();
    eng.prompt(&s.id, "hello").unwrap();
    wait_for(&mut rx, |e| matches!(e, EngineEvent::TurnEnded { .. })).await;
    let old_sid = eng.store().get_session(&s.id).unwrap().acp_session_id.unwrap();
    eng.close_session(&s.id).await.unwrap();
    // Delete the agent's own record (like a crash before it was saved)
    std::fs::remove_dir_all(base.join(".plyfold-mock")).unwrap();

    eng.reopen_session(&s.id).await.unwrap();
    assert!(eng.is_running(&s.id));
    let new_sid = eng.store().get_session(&s.id).unwrap().acp_session_id.unwrap();
    assert_ne!(old_sid, new_sid);
    let events = eng.store().events(&s.id, None, 1000).unwrap();
    assert!(events.iter().any(|e| e.payload.contains("記録が見つからない")));
    eng.close_session(&s.id).await.unwrap();
}
