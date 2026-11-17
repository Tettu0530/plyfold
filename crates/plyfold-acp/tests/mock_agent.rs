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
    let s = client.new_session(&dir).await.unwrap();
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
    let sid = client.new_session(&dir).await.unwrap().session_id.0.to_string();

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
    let sid = client.new_session(&dir).await.unwrap().session_id.0.to_string();
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
        let sid = client.new_session(&dir).await.unwrap().session_id.0.to_string();
        client.prompt(&sid, "first").await.unwrap();
        client.shutdown().await;
        sid
    };
    let (client, mut rx) = AcpClient::connect(&spec(&dir), None).await.unwrap();
    client.load_session(&sid, &dir).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let msgs = drain(&mut rx);
    assert_eq!(agent_text(&msgs), "echo: first");
    assert!(msgs.iter().any(|m| matches!(m, AgentMessage::Update { typed: Some(u), .. } if matches!(u.as_ref(), SessionUpdate::UserMessageChunk(_)))));
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
    let sid = client.new_session(&dir).await.unwrap().session_id.0.to_string();
    client.prompt(&sid, "my key is supersecret-value").await.unwrap();
    client.shutdown().await;
    let all = frames.lock().unwrap().join("\n");
    assert!(all.contains("***"));
    assert!(!all.contains("supersecret-value"));
}
