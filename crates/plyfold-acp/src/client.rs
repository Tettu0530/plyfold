//! 型付きの ACP クライアント（v1）

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol_schema::ProtocolVersion;
use agent_client_protocol_schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, FileSystemCapabilities, Implementation,
    InitializeRequest, InitializeResponse, LoadSessionRequest, NewSessionRequest, NewSessionResponse,
    PromptRequest, PromptResponse, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate, SetSessionModeRequest, TextContent,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::transport::{AcpError, Connection, FrameSink, Incoming, SpawnSpec};

pub const INIT_TIMEOUT: Duration = Duration::from_secs(180); // npx の初回ダウンロードを見込む
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(120);

/// エージェントからの通知・リクエストを、扱いやすい形にしたもの
#[derive(Debug, Clone)]
pub enum AgentMessage {
    /// session/update。型に変換できないもの（新しい種類など）は typed が None
    Update { session_id: String, typed: Option<Box<SessionUpdate>>, raw: Value },
    /// session/request_permission。応答は `respond_permission` で返す
    PermissionRequest { request_id: Value, request: Box<RequestPermissionRequest> },
    /// それ以外のリクエスト（fs/*、terminal/* など）。応答しないとエージェントが待ち続けるので、
    /// 受け取った側が `respond_unsupported` などで必ず返すこと
    OtherRequest { request_id: Value, method: String, params: Value },
    /// それ以外の通知（auth/status_update など）
    OtherNotification { method: String, params: Value },
    /// プロセスが終了した
    Closed,
}

#[derive(Debug, Clone)]
pub struct TurnResult {
    pub response: PromptResponse,
    pub barrier: u64,
}

pub struct AcpClient {
    conn: Arc<Connection>,
    pub init: InitializeResponse,
}

impl AcpClient {
    /// 起動して initialize まで済ませる
    pub async fn connect(
        spec: &SpawnSpec,
        sink: Option<FrameSink>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AgentMessage>), AcpError> {
        let (conn, raw_rx) = Connection::spawn(spec, sink).await?;
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(translate(raw_rx, tx));

        let req = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(
                ClientCapabilities::new()
                    // ファイルはエージェントが worktree の中で自分で読み書きする
                    .fs(FileSystemCapabilities::new().read_text_file(false).write_text_file(false))
                    .terminal(false),
            )
            .client_info(Implementation::new("plyfold", env!("CARGO_PKG_VERSION")).title("Plyfold"));
        let init = match conn.request::<_, InitializeResponse>("initialize", &req, Some(INIT_TIMEOUT)).await {
            Ok(r) => r,
            Err(e) => {
                conn.kill().await;
                return Err(e);
            }
        };
        Ok((Self { conn, init }, rx))
    }

    pub fn connection(&self) -> &Arc<Connection> {
        &self.conn
    }

    pub fn supports_load_session(&self) -> bool {
        self.init.agent_capabilities.load_session
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<(), AcpError> {
        self.conn
            .request_raw("authenticate", serde_json::json!({ "methodId": method_id }), Some(SESSION_TIMEOUT))
            .await
            .map(|_| ())
    }

    pub async fn new_session(&self, cwd: &Path) -> Result<NewSessionResponse, AcpError> {
        self.conn.request("session/new", &NewSessionRequest::new(cwd), Some(SESSION_TIMEOUT)).await
    }

    /// 既存のセッションを開き直す。履歴は session/update の通知として再送される。
    /// 戻り値は（応答の JSON, 区切り）。応答には configOptions や modes が入っていることがある
    pub async fn load_session(&self, session_id: &str, cwd: &Path) -> Result<(Value, u64), AcpError> {
        self.conn
            .request_with_barrier(
                "session/load",
                serde_json::to_value(LoadSessionRequest::new(SessionId::new(session_id), cwd)).expect("serialize"),
                Some(SESSION_TIMEOUT),
            )
            .await
    }

    /// 設定項目（model、effort、mode など）を変える。戻り値は変更後の configOptions（生の JSON）
    pub async fn set_config_option(&self, session_id: &str, config_id: &str, value: &str) -> Result<Value, AcpError> {
        let v = self
            .conn
            .request_raw(
                "session/set_config_option",
                serde_json::json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                Some(SESSION_TIMEOUT),
            )
            .await?;
        Ok(v["configOptions"].clone())
    }

    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<(), AcpError> {
        self.conn
            .request_raw(
                "session/set_mode",
                serde_json::to_value(SetSessionModeRequest::new(SessionId::new(session_id), mode_id.to_string()))
                    .expect("serialize"),
                Some(SESSION_TIMEOUT),
            )
            .await
            .map(|_| ())
    }

    /// 1 ターン分。終わるまで返らない（中断は `cancel` を別のタスクから呼ぶ）。
    /// `barrier` は、このターンの通知（AgentMessage）が何件目までかを表す。受け取った AgentMessage を
    /// その件数まで処理してからターンの終わりを扱えば、最後の発言を取りこぼさない
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<TurnResult, AcpError> {
        let req = PromptRequest::new(SessionId::new(session_id), vec![ContentBlock::Text(TextContent::new(text))]);
        let params = serde_json::to_value(req).expect("serialize");
        let (v, barrier) = self.conn.request_with_barrier("session/prompt", params, None).await?;
        let response = serde_json::from_value(v)
            .map_err(|source| AcpError::Decode { method: "session/prompt".into(), source })?;
        Ok(TurnResult { response, barrier })
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpError> {
        self.conn.notify("session/cancel", &CancelNotification::new(SessionId::new(session_id))).await
    }

    /// option_id が None ならキャンセル扱い
    pub async fn respond_permission(&self, request_id: Value, option_id: Option<&str>) -> Result<(), AcpError> {
        let outcome = match option_id {
            Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id.to_string())),
            None => RequestPermissionOutcome::Cancelled,
        };
        let v = serde_json::to_value(RequestPermissionResponse::new(outcome)).expect("serialize");
        self.conn.respond(request_id, v).await
    }

    pub async fn respond_unsupported(&self, request_id: Value) -> Result<(), AcpError> {
        self.conn.respond_error(request_id, AcpError::METHOD_NOT_FOUND, "not supported by plyfold").await
    }

    pub async fn shutdown(&self) {
        self.conn.kill().await;
    }
}

async fn translate(mut raw: mpsc::UnboundedReceiver<Incoming>, tx: mpsc::UnboundedSender<AgentMessage>) {
    while let Some(msg) = raw.recv().await {
        let out = match msg {
            Incoming::Notification { method, params } if method == "session/update" => {
                let session_id = params["sessionId"].as_str().unwrap_or_default().to_string();
                let typed = serde_json::from_value::<SessionNotification>(params.clone()).ok().map(|n| Box::new(n.update));
                AgentMessage::Update { session_id, typed, raw: params }
            }
            Incoming::Notification { method, params } => AgentMessage::OtherNotification { method, params },
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                match serde_json::from_value::<RequestPermissionRequest>(params.clone()) {
                    Ok(request) => AgentMessage::PermissionRequest { request_id: id, request: Box::new(request) },
                    Err(_) => AgentMessage::OtherRequest { request_id: id, method, params },
                }
            }
            Incoming::Request { id, method, params } => AgentMessage::OtherRequest { request_id: id, method, params },
            Incoming::Closed => AgentMessage::Closed,
        };
        let closed = matches!(out, AgentMessage::Closed);
        if tx.send(out).is_err() || closed {
            break;
        }
    }
}
