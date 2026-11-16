//! 接続テスト: プロファイルでエージェントを起動し、短い問い合わせを 1 回送って、
//! 応答の速さと、応答したモデルを確かめる。セッションの記録には残さない。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use plyfold_acp::{AcpClient, AgentMessage};
use plyfold_profile::{Config, SecretStore};
use serde::Serialize;

use crate::info::{Category, SessionInfo};

const PROMPT: &str = "Reply with exactly one word: OK";
const TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize, Default)]
pub struct CheckResult {
    pub ok: bool,
    /// 送ってから最初の文字が届くまで
    pub first_text_ms: Option<u64>,
    /// 起動から応答が終わるまで
    pub total_ms: u64,
    /// 応答の文（長ければ切る）
    pub reply: String,
    /// API が返したモデル名（エージェントが教えてくれる場合だけ）
    pub reported_model: Option<String>,
    /// 設定で選ばれているモデル
    pub configured_model: Option<String>,
    pub error: Option<String>,
    /// 終わった時刻（UNIX 秒）
    pub at: i64,
}

pub async fn check_profile(config: &Config, profile: &str, state_dir: &Path, secrets: &dyn SecretStore) -> CheckResult {
    let started = Instant::now();
    let mut out = CheckResult { at: now(), ..Default::default() };
    let result = tokio::time::timeout(TIMEOUT, run(config, profile, state_dir, secrets, &mut out)).await;
    match result {
        Ok(Ok(())) => out.ok = true,
        Ok(Err(e)) => out.error = Some(e),
        Err(_) => out.error = Some(format!("{} 秒たっても応答が終わりません", TIMEOUT.as_secs())),
    }
    out.total_ms = started.elapsed().as_millis() as u64;
    out.at = now();
    out
}

async fn run(config: &Config, profile: &str, state_dir: &Path, secrets: &dyn SecretStore, out: &mut CheckResult) -> Result<(), String> {
    let cwd = state_dir.join("check");
    std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
    let resolved = config.resolve(profile, state_dir, &cwd, secrets).map_err(|e| e.to_string())?;
    let (client, mut rx) = AcpClient::connect(&resolved.spawn, None).await.map_err(|e| e.to_string())?;
    let client = Arc::new(client);

    let result = async {
        let r = client.new_session(&cwd).await.map_err(|e| e.to_string())?;
        let sid = r.session_id.0.to_string();
        let info = Arc::new(Mutex::new(SessionInfo::default()));
        info.lock().unwrap().apply_session_response(&serde_json::to_value(&r).unwrap_or_default());

        let text = Arc::new(Mutex::new(String::new()));
        let first = Arc::new(Mutex::new(None::<Instant>));
        let reader = {
            let (client, info, text, first) = (client.clone(), info.clone(), text.clone(), first.clone());
            tokio::spawn(async move {
                while let Some(msg) = rx.recv().await {
                    match msg {
                        AgentMessage::Update { raw, .. } => {
                            let u = &raw["update"];
                            info.lock().unwrap().apply_update(u);
                            if u["sessionUpdate"].as_str() == Some("agent_message_chunk")
                                && let Some(t) = u["content"]["text"].as_str()
                            {
                                first.lock().unwrap().get_or_insert_with(Instant::now);
                                text.lock().unwrap().push_str(t);
                            }
                        }
                        // テストでは何も許可しない
                        AgentMessage::PermissionRequest { request_id, .. } => {
                            let _ = client.respond_permission(request_id, None).await;
                        }
                        AgentMessage::OtherRequest { request_id, .. } => {
                            let _ = client.respond_unsupported(request_id).await;
                        }
                        AgentMessage::OtherNotification { .. } => {}
                        AgentMessage::Closed => break,
                    }
                }
            })
        };

        let sent = Instant::now();
        let turn = client.prompt(&sid, PROMPT).await.map_err(|e| e.to_string())?;
        // 応答の後に届く通知を少しだけ待つ
        tokio::time::sleep(Duration::from_millis(150)).await;
        reader.abort();

        let info = info.lock().unwrap();
        out.configured_model = info.option(Category::Model).and_then(|o| o.current.clone());
        out.reported_model = info.reported_model.clone().or_else(|| turn.raw["_meta"]["model"].as_str().map(str::to_string));
        out.first_text_ms = first.lock().unwrap().map(|t| t.saturating_duration_since(sent).as_millis() as u64);
        let reply = text.lock().unwrap().trim().to_string();
        out.reply = reply.chars().take(200).collect();
        if reply.is_empty() {
            return Err("応答の文が届きませんでした".into());
        }
        Ok(())
    }
    .await;
    client.shutdown().await;
    result
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
