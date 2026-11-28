//! Typed ACP client (v1)

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol_schema::ProtocolVersion;
use agent_client_protocol_schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, FileSystemCapabilities, ForkSessionRequest, ForkSessionResponse, Implementation, InitializeRequest,
    InitializeResponse, ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, McpServer, NewSessionRequest, NewSessionResponse, PromptRequest,
    PromptResponse, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId, SessionInfo,
    SessionNotification, SessionUpdate, SetSessionModeRequest, TextContent,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::transport::{AcpError, Connection, FrameSink, Incoming, SpawnSpec};

pub const INIT_TIMEOUT: Duration = Duration::from_secs(180); // allow for npx's first-run download
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
/// Signing in may wait for the person to finish in a browser
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(300);
/// The auth method that reuses the login a CLI already has
const SAVED_LOGIN: &str = "oauth-personal";

/// Notifications and requests from the agent, in a form that is easy to handle
#[derive(Debug, Clone)]
pub enum AgentMessage {
    /// session/update. `typed` is None when it cannot be parsed (e.g. a new update kind)
    Update { session_id: String, typed: Option<Box<SessionUpdate>>, raw: Value },
    /// session/request_permission. Answer it with `respond_permission`
    PermissionRequest { request_id: Value, request: Box<RequestPermissionRequest> },
    /// Any other request (fs/*, terminal/*, ...). The agent waits until it gets an answer, so the
    /// receiver must always reply, e.g. with `respond_unsupported`
    OtherRequest { request_id: Value, method: String, params: Value },
    /// Any other notification (auth/status_update, ...)
    OtherNotification { method: String, params: Value },
    /// The process exited
    Closed,
}

#[derive(Debug, Clone)]
pub struct TurnResult {
    pub response: PromptResponse,
    /// The raw response JSON (for fields the types do not cover yet, such as `usage`)
    pub raw: Value,
    pub barrier: u64,
}

pub struct AcpClient {
    conn: Arc<Connection>,
    pub init: InitializeResponse,
}

impl AcpClient {
    /// Spawns the agent and completes initialize
    pub async fn connect(spec: &SpawnSpec, sink: Option<FrameSink>) -> Result<(Self, mpsc::UnboundedReceiver<AgentMessage>), AcpError> {
        let (conn, raw_rx) = Connection::spawn(spec, sink).await?;
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(translate(raw_rx, tx));

        let req = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(
                ClientCapabilities::new()
                    // The agent reads and writes files in the worktree itself
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

    /// Whether the agent advertises `sessionCapabilities.fork` (`session/fork` is still marked unstable in the schema)
    pub fn supports_fork(&self) -> bool {
        self.init.agent_capabilities.session_capabilities.fork.is_some()
    }

    /// Whether the agent advertises `sessionCapabilities.list` (`session/list`)
    pub fn supports_list(&self) -> bool {
        self.init.agent_capabilities.session_capabilities.list.is_some()
    }

    /// Whether prompts may contain image blocks (if not, images are passed as file links)
    pub fn supports_images(&self) -> bool {
        self.init.agent_capabilities.prompt_capabilities.image
    }

    /// The agent accepts HTTP MCP servers (`mcpCapabilities.http`)
    pub fn supports_mcp_http(&self) -> bool {
        self.init.agent_capabilities.mcp_capabilities.http
    }

    /// The agent accepts SSE MCP servers (`mcpCapabilities.sse`)
    pub fn supports_mcp_sse(&self) -> bool {
        self.init.agent_capabilities.mcp_capabilities.sse
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<(), AcpError> {
        self.conn.request_raw("authenticate", serde_json::json!({ "methodId": method_id }), Some(AUTH_TIMEOUT)).await.map(|_| ())
    }

    /// When a request was refused for want of authentication, sign in the way the agent's saved login allows and say
    /// the request may be sent again. Only `oauth-personal` (Gemini CLI, Antigravity) is tried: it reuses a login the
    /// person already made in the CLI, and opens a browser only when there is none. Other methods need a key or a
    /// choice, so for those the original error stands
    async fn recover_auth(&self, error: AcpError) -> Result<(), AcpError> {
        let listed = self.init.auth_methods.iter().any(|m| m.id().0.as_ref() == SAVED_LOGIN);
        if error.rpc_code() != Some(AcpError::AUTH_REQUIRED) || !listed {
            return Err(error);
        }
        self.authenticate(SAVED_LOGIN).await.map_err(|_| error)
    }

    pub async fn new_session(&self, cwd: &Path, mcp_servers: Vec<McpServer>) -> Result<NewSessionResponse, AcpError> {
        let mut req = NewSessionRequest::new(cwd);
        if !mcp_servers.is_empty() {
            req = req.mcp_servers(mcp_servers);
        }
        match self.conn.request("session/new", &req, Some(SESSION_TIMEOUT)).await {
            Err(e) => {
                self.recover_auth(e).await?;
                self.conn.request("session/new", &req, Some(SESSION_TIMEOUT)).await
            }
            ok => ok,
        }
    }

    /// Forks an existing session into a new one with the same conversation context.
    /// Returns (response JSON, barrier). The agent does not resend the history.
    /// `mcp_servers` replaces the forked session's list, the same way session/new does.
    pub async fn fork_session(&self, session_id: &str, cwd: &Path, mcp_servers: Vec<McpServer>) -> Result<(Value, u64), AcpError> {
        let mut req = ForkSessionRequest::new(session_id.to_string(), cwd);
        if !mcp_servers.is_empty() {
            req = req.mcp_servers(mcp_servers);
        }
        let (v, barrier) = self.conn.request_with_barrier("session/fork", serde_json::to_value(&req).expect("serialize"), Some(SESSION_TIMEOUT)).await?;
        let _: ForkSessionResponse = serde_json::from_value(v.clone()).map_err(|source| AcpError::Decode { method: "session/fork".into(), source })?;
        Ok((v, barrier))
    }

    /// Sessions the agent already has for this directory. Follows `nextCursor` until it stops or repeats.
    /// The caller checks `supports_list` first; a missing method comes back as an RPC error.
    pub async fn list_sessions(&self, cwd: &Path) -> Result<Vec<SessionInfo>, AcpError> {
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for _ in 0..32 {
            let mut req = ListSessionsRequest::new().cwd(cwd.to_path_buf());
            if let Some(c) = cursor.clone() {
                req = req.cursor(c);
            }
            let page: ListSessionsResponse = self.conn.request("session/list", &req, Some(SESSION_TIMEOUT)).await?;
            out.extend(page.sessions);
            match page.next_cursor {
                Some(next) if !next.is_empty() && seen.insert(next.clone()) => cursor = Some(next),
                _ => break,
            }
        }
        Ok(out)
    }

    /// Reopens an existing session. The history is replayed as session/update notifications.
    /// Returns (response JSON, barrier). The response may contain configOptions and modes
    pub async fn load_session(&self, session_id: &str, cwd: &Path, mcp_servers: Vec<McpServer>) -> Result<(Value, u64), AcpError> {
        let mut req = LoadSessionRequest::new(SessionId::new(session_id), cwd);
        if !mcp_servers.is_empty() {
            req = req.mcp_servers(mcp_servers);
        }
        let req = serde_json::to_value(req).expect("serialize");
        match self.conn.request_with_barrier("session/load", req.clone(), Some(SESSION_TIMEOUT)).await {
            Err(e) => {
                self.recover_auth(e).await?;
                self.conn.request_with_barrier("session/load", req, Some(SESSION_TIMEOUT)).await
            }
            ok => ok,
        }
    }

    /// Changes a config option (model, effort, mode, ...). Returns the updated configOptions as raw JSON
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
                serde_json::to_value(SetSessionModeRequest::new(SessionId::new(session_id), mode_id.to_string())).expect("serialize"),
                Some(SESSION_TIMEOUT),
            )
            .await
            .map(|_| ())
    }

    /// Runs one turn and returns only when it ends (to interrupt, call `cancel` from another task).
    /// `barrier` is the count of notifications (AgentMessage) belonging to this turn. Process received
    /// AgentMessages up to that count before handling the end of the turn, so the last message is not lost
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<TurnResult, AcpError> {
        self.prompt_blocks(session_id, vec![ContentBlock::Text(TextContent::new(text))]).await
    }

    /// Sends image and file-link blocks in addition to text
    pub async fn prompt_blocks(&self, session_id: &str, blocks: Vec<ContentBlock>) -> Result<TurnResult, AcpError> {
        let req = PromptRequest::new(SessionId::new(session_id), blocks);
        let params = serde_json::to_value(req).expect("serialize");
        let (v, barrier) = self.conn.request_with_barrier("session/prompt", params, None).await?;
        let response = serde_json::from_value(v.clone()).map_err(|source| AcpError::Decode { method: "session/prompt".into(), source })?;
        Ok(TurnResult { response, raw: v, barrier })
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpError> {
        self.conn.notify("session/cancel", &CancelNotification::new(SessionId::new(session_id))).await
    }

    /// A None option_id is treated as a cancel
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
