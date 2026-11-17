//! Minimal ACP JSON-RPC client (newline-delimited JSON over stdio)
//!
//! This is a test tool, so every message sent or received is kept in transcript.jsonl.

use std::collections::HashMap;
use std::fmt;
use std::io::Write as _;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

use crate::config::Launch;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const AUTH_REQUIRED: i64 = -32000;
    /// Errors raised on our side (disconnects, timeouts)
    pub const TRANSPORT: i64 = -1;

    fn transport(msg: impl Into<String>) -> Self {
        Self { code: Self::TRANSPORT, message: msg.into(), data: None }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RPC error {}: {}", self.code, self.message)?;
        if let Some(d) = &self.data {
            write!(f, " ({d})")?;
        }
        Ok(())
    }
}

impl std::error::Error for RpcError {}

pub enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

pub struct Transcript {
    file: Mutex<std::fs::File>,
    start: Instant,
    secrets: Vec<String>,
}

impl Transcript {
    fn new(path: &Path, secrets: Vec<String>) -> Result<Self> {
        Ok(Self { file: Mutex::new(std::fs::File::create(path)?), start: Instant::now(), secrets })
    }

    pub fn redact(&self, s: &str) -> String {
        let mut s = s.to_string();
        for secret in &self.secrets {
            if !secret.is_empty() {
                s = s.replace(secret.as_str(), "***");
            }
        }
        s
    }

    fn log(&self, dir: &str, raw: &str) {
        let ms = self.start.elapsed().as_millis();
        let body = self.redact(raw);
        // Keep incoming lines that are not JSON as strings
        let body = if serde_json::from_str::<Value>(&body).is_ok() { body } else { Value::String(body).to_string() };
        if let Ok(mut f) = self.file.lock() {
            let _ = writeln!(f, "{{\"ms\":{ms},\"dir\":\"{dir}\",\"msg\":{body}}}");
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct Conn {
    stdin: tokio::sync::Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Pending,
    pub transcript: Arc<Transcript>,
    child: tokio::sync::Mutex<Child>,
}

impl Conn {
    pub async fn spawn(launch: &Launch, cwd: &Path, run_dir: &Path) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Incoming>)> {
        let transcript = Arc::new(Transcript::new(&run_dir.join("transcript.jsonl"), launch.secrets.clone())?);

        let mut cmd = Command::new(&launch.command);
        cmd.args(&launch.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        for var in &launch.env_remove {
            cmd.env_remove(var);
        }
        for (k, v) in &launch.env_set {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().with_context(|| format!("cannot start: {} {}", launch.command, launch.args.join(" ")))?;

        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        // stderr goes to a file
        {
            let path = run_dir.join("stderr.log");
            let transcript = transcript.clone();
            tokio::spawn(async move {
                let Ok(mut f) = std::fs::File::create(path) else { return };
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = writeln!(f, "{}", transcript.redact(&line));
                }
            });
        }

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::unbounded_channel();

        {
            let pending = pending.clone();
            let transcript = transcript.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    transcript.log("in", &line);
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
                    let id = msg.get("id").cloned();
                    match (method, id) {
                        (Some(method), Some(id)) => {
                            let params = msg.get("params").cloned().unwrap_or(Value::Null);
                            let _ = tx.send(Incoming::Request { id, method, params });
                        }
                        (Some(method), None) => {
                            let params = msg.get("params").cloned().unwrap_or(Value::Null);
                            let _ = tx.send(Incoming::Notification { method, params });
                        }
                        (None, Some(id)) => {
                            let Some(id) = id.as_u64() else { continue };
                            let Some(waiter) = pending.lock().unwrap().remove(&id) else { continue };
                            let result = if let Some(err) = msg.get("error") {
                                Err(RpcError {
                                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                                    message: err.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                                    data: err.get("data").cloned(),
                                })
                            } else {
                                Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = waiter.send(result);
                        }
                        (None, None) => {}
                    }
                }
                // When the agent exits, fail every pending request
                for (_, waiter) in pending.lock().unwrap().drain() {
                    let _ = waiter.send(Err(RpcError::transport("the agent process exited")));
                }
            });
        }

        let conn =
            Arc::new(Self { stdin: tokio::sync::Mutex::new(stdin), next_id: AtomicU64::new(0), pending, transcript, child: tokio::sync::Mutex::new(child) });
        Ok((conn, rx))
    }

    async fn send(&self, msg: Value) -> Result<(), RpcError> {
        let line = msg.to_string();
        self.transcript.log("out", &line);
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(format!("{line}\n").as_bytes()).await.map_err(|e| RpcError::transport(format!("write failed: {e}")))?;
        stdin.flush().await.map_err(|e| RpcError::transport(format!("flush failed: {e}")))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await?;
        rx.await.unwrap_or_else(|_| Err(RpcError::transport("no response received")))
    }

    pub async fn request_timeout(&self, method: &str, params: Value, dur: Duration) -> Result<Value, RpcError> {
        match tokio::time::timeout(dur, self.request(method, params)).await {
            Ok(r) => r,
            Err(_) => Err(RpcError::transport(format!("{method} timed out after {} s", dur.as_secs()))),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params})).await
    }

    pub async fn respond(&self, id: Value, result: Value) {
        let _ = self.send(json!({"jsonrpc": "2.0", "id": id, "result": result})).await;
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) {
        let _ = self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})).await;
    }

    pub async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }
}
