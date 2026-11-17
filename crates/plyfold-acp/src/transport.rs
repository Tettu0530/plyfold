//! The agent process and newline-delimited JSON-RPC (ACP's stdio transport)

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

use crate::redact::Redactor;

/// How to launch the agent
#[derive(Debug, Clone, Default)]
pub struct SpawnSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    /// Values that must never appear in logs (keys, etc.)
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    In,
    Out,
}

/// Destination for sent and received messages (e.g. the event log). Values arrive already redacted
pub type FrameSink = Arc<dyn Fn(Direction, &str) + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("{}", plyfold_i18n::tr!("RPC エラー {}: {}", "RPC error {}: {}", "RPC 错误 {}：{}", .code, .message))]
    Rpc { code: i64, message: String, data: Option<Value> },
    #[error("{}", plyfold_i18n::tr!("{} が {} 秒でタイムアウトしました", "{} timed out after {} seconds", "{} 在 {} 秒后超时", .method, .secs))]
    Timeout { method: String, secs: u64 },
    #[error("{}", plyfold_i18n::tr!("エージェントとの接続が切れました: {}", "Lost the connection to the agent: {}", "与代理的连接已断开：{}", .0))]
    Closed(String),
    #[error("{}", plyfold_i18n::tr!("エージェントを起動できません（{}）: {}", "Cannot start the agent ({}): {}", "无法启动代理（{}）：{}", .command, .source))]
    Spawn { command: String, source: std::io::Error },
    #[error("{}", plyfold_i18n::tr!("応答の形式が想定と違います（{}）: {}", "Unexpected response format ({}): {}", "响应格式与预期不符（{}）：{}", .method, .source))]
    Decode { method: String, source: serde_json::Error },
    #[error("{}", plyfold_i18n::tr!("書き込みに失敗しました: {}", "Write failed: {}", "写入失败：{}", .0))]
    Io(#[from] std::io::Error),
}

impl AcpError {
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const AUTH_REQUIRED: i64 = -32000;

    pub fn rpc_code(&self) -> Option<i64> {
        match self {
            Self::Rpc { code, .. } => Some(*code),
            _ => None,
        }
    }
}

/// Something received from the agent
#[derive(Debug, Clone)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// The process's stdout closed (it exited)
    Closed,
}

/// A response, plus the number of requests and notifications received from the agent up to that point (the barrier)
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<(Value, u64), AcpError>>>>>;

const STDERR_TAIL: usize = 200;

pub struct Connection {
    stdin: tokio::sync::Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Pending,
    child: tokio::sync::Mutex<Child>,
    redactor: Arc<Redactor>,
    sink: Option<FrameSink>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl Connection {
    pub async fn spawn(spec: &SpawnSpec, sink: Option<FrameSink>) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Incoming>), AcpError> {
        let redactor = Arc::new(Redactor::new(spec.secrets.clone()));

        // On Windows `npx` is `npx.cmd`: look the program up the way a shell would, and don't flash a console window
        #[cfg(windows)]
        let mut cmd = {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let program = which::which(&spec.command).map(|p| p.into_os_string()).unwrap_or_else(|_| spec.command.clone().into());
            let mut c = Command::new(program);
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args).current_dir(&spec.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        for var in &spec.env_remove {
            cmd.env_remove(var);
        }
        for (k, v) in &spec.env_set {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(|source| AcpError::Spawn { command: spec.command.clone(), source })?;

        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        {
            let tail = stderr_tail.clone();
            let redactor = redactor.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut t = tail.lock().unwrap();
                    if t.len() == STDERR_TAIL {
                        t.pop_front();
                    }
                    t.push_back(redactor.redact(&line));
                }
            });
        }

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let delivered = Arc::new(AtomicU64::new(0));
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let pending = pending.clone();
            let delivered = delivered.clone();
            let redactor = redactor.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Some(sink) = &sink {
                        sink(Direction::In, &redactor.redact(&line));
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        tracing::warn!("received a non-JSON line: {}", redactor.redact(&line));
                        continue;
                    };
                    dispatch(msg, &pending, &tx, &delivered);
                }
                for (_, waiter) in pending.lock().unwrap().drain() {
                    let _ = waiter.send(Err(AcpError::Closed(plyfold_i18n::tr!("プロセスが終了しました", "the process exited", "进程已退出"))));
                }
                let _ = tx.send(Incoming::Closed);
            });
        }

        let conn = Arc::new(Self {
            stdin: tokio::sync::Mutex::new(stdin),
            next_id: AtomicU64::new(0),
            pending,
            child: tokio::sync::Mutex::new(child),
            redactor,
            sink,
            stderr_tail,
        });
        Ok((conn, rx))
    }

    async fn send(&self, msg: Value) -> Result<(), AcpError> {
        let line = msg.to_string();
        if let Some(sink) = &self.sink {
            sink(Direction::Out, &self.redactor.redact(&line));
        }
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn request_raw(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, AcpError> {
        self.request_with_barrier(method, params, timeout).await.map(|(v, _)| v)
    }

    /// Returns a "barrier" along with the response: the number of requests and notifications handed out as
    /// `Incoming` by the time the response arrived. If the receiver processes that many, nothing sent before the response is lost
    pub async fn request_with_barrier(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<(Value, u64), AcpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let wait = async {
            rx.await.unwrap_or_else(|_| Err(AcpError::Closed(plyfold_i18n::tr!("応答を受け取れませんでした", "no response was received", "未收到响应"))))
        };
        match timeout {
            None => wait.await,
            Some(d) => match tokio::time::timeout(d, wait).await {
                Ok(r) => r,
                Err(_) => {
                    self.pending.lock().unwrap().remove(&id);
                    Err(AcpError::Timeout { method: method.into(), secs: d.as_secs() })
                }
            },
        }
    }

    pub async fn request<P: Serialize, R: DeserializeOwned>(&self, method: &str, params: &P, timeout: Option<Duration>) -> Result<R, AcpError> {
        let params = serde_json::to_value(params).map_err(|source| AcpError::Decode { method: method.into(), source })?;
        let v = self.request_raw(method, params, timeout).await?;
        serde_json::from_value(v).map_err(|source| AcpError::Decode { method: method.into(), source })
    }

    pub async fn notify<P: Serialize>(&self, method: &str, params: &P) -> Result<(), AcpError> {
        let params = serde_json::to_value(params).map_err(|source| AcpError::Decode { method: method.into(), source })?;
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params})).await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), AcpError> {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result})).await
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), AcpError> {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})).await
    }

    /// The last few hundred lines of stderr (redacted). Used to show why a launch failed
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap().iter().cloned().collect()
    }

    pub async fn kill(&self) {
        let mut child = self.child.lock().await;
        // On Windows the agent runs under cmd.exe (npx.cmd) and node; ending only the first would leave the rest
        // running, so end the whole process tree
        #[cfg(windows)]
        if let Some(pid) = child.id() {
            use std::os::windows::process::CommandExt as _;
            let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x0800_0000).status();
        }
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }
}

fn dispatch(msg: Value, pending: &Pending, tx: &mpsc::UnboundedSender<Incoming>, delivered: &AtomicU64) {
    let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    match (method, msg.get("id").cloned()) {
        (Some(method), Some(id)) => {
            delivered.fetch_add(1, Ordering::SeqCst);
            let _ = tx.send(Incoming::Request { id, method, params });
        }
        (Some(method), None) => {
            delivered.fetch_add(1, Ordering::SeqCst);
            let _ = tx.send(Incoming::Notification { method, params });
        }
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let Some(waiter) = pending.lock().unwrap().remove(&id) else { return };
            let result = match msg.get("error") {
                Some(err) => Err(AcpError::Rpc {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                    data: err.get("data").cloned(),
                }),
                None => Ok((msg.get("result").cloned().unwrap_or(Value::Null), delivered.load(Ordering::SeqCst))),
            };
            let _ = waiter.send(result);
        }
        (None, None) => {}
    }
}
