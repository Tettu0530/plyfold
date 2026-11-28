//! Integration tests against the mock agent

use std::time::Duration;

use plyfold_acp::schema::{SessionUpdate, StopReason};
use plyfold_acp::{AcpClient, AgentMessage, SpawnSpec};
use tokio::sync::mpsc::UnboundedReceiver;

fn spec(cwd: &std::path::Path) -> SpawnSpec {
    SpawnSpec { command: env!("CARGO_BIN_EXE_plyfold-mock-agent").into(), cwd: cwd.to_path_buf(), ..Default::default() }
}

fn tempdir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("plyfold-acp-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn agent_text(msgs: &[AgentMessage]) -> String {
    msgs.iter()
        .filter_map(|m| match m {
            AgentMessage::Update { typed: Some(u), .. } => match u.as_ref() {
                SessionUpdate::AgentMessageChunk(c) => match &c.content {
                    plyfold_acp::schema::ContentBlock::Text(t) => Some(t.text.clone()),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn drain(rx: &mut UnboundedReceiver<AgentMessage>) -> Vec<AgentMessage> {
    let mut v = Vec::new();
    while let Ok(m) = rx.try_recv() {
        v.push(m);
    }
    v
}

#[tokio::test]
async fn echo_turn() {
    let dir = tempdir("echo");
    let (client, mut rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
    assert!(client.supports_load_session());
    assert!(client.supports_fork());
    assert!(client.supports_list());
    let s = client.new_session(&dir, vec![]).await.unwrap();
    let r = client.prompt(&s.session_id.0, "hello").await.unwrap();
    assert_eq!(r.response.stop_reason, StopReason::EndTurn);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(agent_text(&drain(&mut rx)), "echo: hello");
    client.shutdown().await;
}

#[tokio::test]
async fn permission_allow_and_reject() {
    let dir = tempdir("perm");
    let (client, mut rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
    let client = std::sync::Arc::new(client);
    let sid = client.new_session(&dir, vec![]).await.unwrap().session_id.0.to_string();

    for (choice, expect_file) in [("allow", true), ("reject", false)] {
        let _ = std::fs::remove_file(dir.join("mock-output.txt"));
        let c = client.clone();
        let s = sid.clone();
        let turn = tokio::spawn(async move { c.prompt(&s, "please ask permission").await });
        loop {
            match rx.recv().await.unwrap() {
                AgentMessage::PermissionRequest { request_id, request } => {
                    assert_eq!(request.options.len(), 2);
                    client.respond_permission(request_id, Some(choice)).await.unwrap();
                    break;
                }
                _ => continue,
            }
        }
        let r = turn.await.unwrap().unwrap();
        assert_eq!(r.response.stop_reason, StopReason::EndTurn);
        assert_eq!(dir.join("mock-output.txt").exists(), expect_file, "{choice}");
    }
    client.shutdown().await;
}

#[tokio::test]
async fn cancel_hanging_turn() {
    let dir = tempdir("cancel");
    let (client, _rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
    let client = std::sync::Arc::new(client);
    let sid = client.new_session(&dir, vec![]).await.unwrap().session_id.0.to_string();
    let c = client.clone();
    let s = sid.clone();
    let turn = tokio::spawn(async move { c.prompt(&s, "hang please").await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    client.cancel(&sid).await.unwrap();
    let r = tokio::time::timeout(Duration::from_secs(5), turn).await.unwrap().unwrap().unwrap();
    assert_eq!(r.response.stop_reason, StopReason::Cancelled);
    client.shutdown().await;
}

#[tokio::test]
async fn load_session_replays_history_in_new_process() {
    let dir = tempdir("load");
    let sid = {
        let (client, _rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
        let sid = client.new_session(&dir, vec![]).await.unwrap().session_id.0.to_string();
        client.prompt(&sid, "first").await.unwrap();
        client.shutdown().await;
        sid
    };
    let (client, mut rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
    client.load_session(&sid, &dir, vec![]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let msgs = drain(&mut rx);
    assert_eq!(agent_text(&msgs), "echo: first");
    assert!(msgs.iter().any(|m| matches!(m, AgentMessage::Update { typed: Some(u), .. } if matches!(u.as_ref(), SessionUpdate::UserMessageChunk(_)))));
    client.shutdown().await;
}

#[tokio::test]
async fn fork_session_copies_history_into_a_new_process() {
    let dir = tempdir("fork");
    let other = tempdir("fork-cwd");
    let sid = {
        let (client, _rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
        let sid = client.new_session(&dir, vec![]).await.unwrap().session_id.0.to_string();
        client.prompt(&sid, "remember this").await.unwrap();
        client.shutdown().await;
        sid
    };
    let (client, mut rx) = AcpClient::connect(&spec(&other), None).await.unwrap();
    let (resp, _) = client.fork_session(&sid, &other, vec![]).await.unwrap();
    let new_id = resp["sessionId"].as_str().unwrap().to_string();
    assert_ne!(new_id, sid);
    // Fork does not resend the conversation
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(drain(&mut rx).is_empty());
    let copied = std::fs::read_to_string(other.join(".plyfold-mock").join(format!("{new_id}.jsonl"))).unwrap();
    assert!(copied.contains("remember this"));
    client.prompt(&new_id, "next").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(agent_text(&drain(&mut rx)), "echo: next");
    let missing = client.fork_session("no-such-session", &other, vec![]).await;
    assert!(matches!(missing, Err(plyfold_acp::AcpError::Rpc { code: -32002, .. })));
    client.shutdown().await;
}

#[tokio::test]
async fn list_sessions_then_load_into_another_directory() {
    let dir = tempdir("list");
    let other = tempdir("list-cwd");
    let sid = {
        let (client, _rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
        let sid = client.new_session(&dir, vec![]).await.unwrap().session_id.0.to_string();
        client.prompt(&sid, "remember this").await.unwrap();
        client.shutdown().await;
        sid
    };
    let (client, mut rx) = AcpClient::connect(&spec(&other), None).await.unwrap();
    let listed = client.list_sessions(&dir).await.unwrap();
    assert!(listed.iter().any(|s| s.session_id.0.as_ref() == sid && s.title.as_deref() == Some("remember this")));
    assert!(client.list_sessions(&other).await.unwrap().is_empty());
    client.load_session(&sid, &other, vec![]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(agent_text(&drain(&mut rx)), "echo: remember this");
    assert!(other.join(".plyfold-mock").join(format!("{sid}.jsonl")).is_file());
    client.shutdown().await;
}

#[tokio::test]
async fn sink_receives_redacted_frames() {
    let dir = tempdir("sink");
    let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let f = frames.clone();
    let sink: plyfold_acp::FrameSink = std::sync::Arc::new(move |_, s: &str| f.lock().unwrap().push(s.to_string()));
    let mut sp = spec(&dir);
    sp.secrets = vec!["supersecret-value".into()];
    let (client, _rx) = AcpClient::connect(&sp, Some(sink)).await.unwrap();
    let sid = client.new_session(&dir, vec![]).await.unwrap().session_id.0.to_string();
    client.prompt(&sid, "my key is supersecret-value").await.unwrap();
    client.shutdown().await;
    let all = frames.lock().unwrap().join("\n");
    assert!(all.contains("***"));
    assert!(!all.contains("supersecret-value"));
}

/// An agent that refuses a session until the saved login is used (Antigravity, Gemini CLI): the client signs in and
/// asks again, and a client of an agent without that method keeps the original error
#[tokio::test]
async fn a_session_refused_for_want_of_login_is_retried_after_signing_in() {
    let dir = tempdir("auth");
    let mut with = spec(&dir);
    with.env_set.push(("MOCK_AUTH".into(), "1".into()));
    let (client, _rx) = AcpClient::connect(&with, None).await.unwrap();
    assert!(client.new_session(&dir, vec![]).await.is_ok());

    let mut other = spec(&dir);
    other.env_set.push(("MOCK_AUTH".into(), "1".into()));
    let (client, _rx) = AcpClient::connect(&other, None).await.unwrap();
    // load goes the same way
    let err = client.load_session("nope", &dir, vec![]).await.unwrap_err();
    assert_eq!(err.rpc_code(), Some(-32002), "after signing in the request itself was answered: {err}");
}

/// A profile with a Gemini key signs in with the key; one without uses the saved login
#[tokio::test]
async fn the_method_follows_whether_the_profile_has_a_key() {
    let dir = tempdir("auth-key");
    let mut keyed = spec(&dir);
    keyed.env_set.extend([("MOCK_AUTH".into(), "1".into()), ("MOCK_AUTH_METHOD".into(), "gemini-api-key".into()), ("GEMINI_API_KEY".into(), "k".into())]);
    let (client, _rx) = AcpClient::connect(&keyed, None).await.unwrap();
    assert!(client.new_session(&dir, vec![]).await.is_ok(), "the key's method signs in");

    // Without a key the saved login is tried, which this agent refuses: the original error stands
    let mut plain = spec(&dir);
    plain.env_set.extend([("MOCK_AUTH".into(), "1".into()), ("MOCK_AUTH_METHOD".into(), "gemini-api-key".into())]);
    let (client, _rx) = AcpClient::connect(&plain, None).await.unwrap();
    let err = client.new_session(&dir, vec![]).await.unwrap_err();
    assert_eq!(err.rpc_code(), Some(-32000));
}
