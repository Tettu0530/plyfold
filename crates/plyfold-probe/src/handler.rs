//! Handling of agent requests (permission, file read/write) and notifications (session/update)

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::conn::{Conn, Incoming, RpcError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Policy {
    /// Choose in the terminal every time
    Ask,
    /// Automatically pick the allow-once option
    Allow,
    /// Automatically pick the reject-once option
    Reject,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Stats {
    /// Count per sessionUpdate kind
    pub updates: BTreeMap<String, u64>,
    /// Count of agent requests per method
    pub agent_requests: BTreeMap<String, u64>,
    pub permission_option_kinds: BTreeSet<String>,
    pub tool_kinds: BTreeSet<String>,
    /// Types seen in tool call content (diff, terminal, content, ...)
    pub tool_content_types: BTreeSet<String>,
    pub diff_paths: BTreeSet<String>,
    pub agent_text_chars: usize,
    pub notes: Vec<String>,
}

pub struct Shared {
    pub label: String,
    pub policy: Policy,
    pub cwd: PathBuf,
    /// When true, print only events such as tool calls, not the streamed text
    pub quiet: bool,
    pub cancelled: AtomicBool,
    pub stats: Mutex<Stats>,
    /// Record of one turn (for bench; cleared with reset_turn before each turn)
    pub turn: Mutex<Turn>,
}

#[derive(Debug, Default, Clone)]
pub struct Turn {
    pub text: String,
    pub first_text_at: Option<std::time::Instant>,
    /// `used` from usage_update (tokens currently in context)
    pub used: Option<u64>,
    /// _meta._claude/model from usage_update (the actual model name the API returned)
    pub model: Option<String>,
}

impl Shared {
    pub fn new(label: String, policy: Policy, cwd: PathBuf, quiet: bool) -> Arc<Self> {
        Arc::new(Self {
            label,
            policy,
            cwd,
            quiet,
            cancelled: AtomicBool::new(false),
            stats: Mutex::new(Stats::default()),
            turn: Mutex::new(Turn::default()),
        })
    }

    pub fn reset_turn(&self) {
        *self.turn.lock().unwrap() = Turn::default();
    }

    fn event(&self, msg: &str) {
        if self.quiet {
            println!("[{}] {msg}", self.label);
        } else {
            println!("\n{msg}");
        }
    }

    pub fn note(&self, msg: impl Into<String>) {
        let msg = msg.into();
        self.event(&format!("note: {msg}"));
        self.stats.lock().unwrap().notes.push(msg);
    }
}

pub fn spawn_dispatcher(conn: Arc<Conn>, mut rx: mpsc::UnboundedReceiver<Incoming>, shared: Arc<Shared>) {
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                Incoming::Notification { method, params } => {
                    if method == "session/update" {
                        on_update(&shared, &params);
                    } else {
                        shared.event(&format!("[notify] {method}"));
                        *shared.stats.lock().unwrap().updates.entry(format!("(notify) {method}")).or_default() += 1;
                    }
                }
                Incoming::Request { id, method, params } => {
                    *shared.stats.lock().unwrap().agent_requests.entry(method.clone()).or_default() += 1;
                    let conn = conn.clone();
                    let shared = shared.clone();
                    // Keep handling notifications while a permission prompt waits for input
                    tokio::spawn(async move { on_request(&conn, &shared, id, &method, params).await });
                }
            }
        }
    });
}

fn on_update(shared: &Shared, params: &Value) {
    let update = &params["update"];
    let kind = update["sessionUpdate"].as_str().unwrap_or("(unknown)").to_string();
    let mut stats = shared.stats.lock().unwrap();
    *stats.updates.entry(kind.clone()).or_default() += 1;

    match kind.as_str() {
        "agent_message_chunk" | "agent_thought_chunk" => {
            if let Some(text) = update["content"]["text"].as_str() {
                if kind == "agent_message_chunk" {
                    stats.agent_text_chars += text.chars().count();
                    let mut turn = shared.turn.lock().unwrap();
                    turn.text.push_str(text);
                    turn.first_text_at.get_or_insert_with(std::time::Instant::now);
                }
                if !shared.quiet {
                    if kind == "agent_thought_chunk" {
                        print!("\x1b[2m{text}\x1b[0m");
                    } else {
                        print!("{text}");
                    }
                    let _ = std::io::stdout().flush();
                }
            }
        }
        "user_message_chunk" => {}
        "tool_call" | "tool_call_update" => {
            if let Some(k) = update["kind"].as_str() {
                stats.tool_kinds.insert(k.to_string());
            }
            if let Some(items) = update["content"].as_array() {
                for item in items {
                    if let Some(t) = item["type"].as_str() {
                        stats.tool_content_types.insert(t.to_string());
                        if t == "diff"
                            && let Some(p) = item["path"].as_str() {
                                stats.diff_paths.insert(p.to_string());
                            }
                    }
                }
            }
            let title = update["title"].as_str().unwrap_or("");
            let status = update["status"].as_str().unwrap_or("");
            let id = update["toolCallId"].as_str().unwrap_or("");
            drop(stats);
            if kind == "tool_call" {
                shared.event(&format!("[tool] {title} ({}) {status}  id={id}", update["kind"].as_str().unwrap_or("?")));
            } else if matches!(status, "completed" | "failed") {
                shared.event(&format!("[tool {status}] id={id} {title}"));
            }
        }
        "plan" => {
            let entries: Vec<String> = update["entries"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|e| format!("  - [{}] {}", e["status"].as_str().unwrap_or("?"), e["content"].as_str().unwrap_or("")))
                        .collect()
                })
                .unwrap_or_default();
            drop(stats);
            shared.event(&format!("[plan]\n{}", entries.join("\n")));
        }
        "usage_update" => {
            let mut turn = shared.turn.lock().unwrap();
            if let Some(u) = update["used"].as_u64() {
                turn.used = Some(u);
            }
            if let Some(m) = update["_meta"]["_claude/model"].as_str() {
                turn.model = Some(m.to_string());
            }
        }
        // Frequent updates are only counted
        "available_commands_update" | "session_info_update" => {}
        other => {
            drop(stats);
            shared.event(&format!("[update] {other}"));
        }
    }
}

static ASK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn on_request(conn: &Conn, shared: &Shared, id: Value, method: &str, params: Value) {
    match method {
        "session/request_permission" => {
            let result = permission(shared, &params).await;
            conn.respond(id, result).await;
        }
        "fs/read_text_file" => match read_text_file(shared, &params) {
            Ok(content) => conn.respond(id, json!({ "content": content })).await,
            Err(e) => conn.respond_error(id, -32002, &e).await,
        },
        "fs/write_text_file" => match write_text_file(shared, &params) {
            Ok(()) => conn.respond(id, json!({})).await,
            Err(e) => conn.respond_error(id, -32002, &e).await,
        },
        other => {
            shared.note(format!("received unsupported request {other} (answered with method not found)"));
            conn.respond_error(id, RpcError::METHOD_NOT_FOUND, "not supported by plyfold-probe").await;
        }
    }
}

async fn permission(shared: &Shared, params: &Value) -> Value {
    let options: Vec<(String, String, String)> = params["options"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|o| {
                    (
                        o["optionId"].as_str().unwrap_or("").to_string(),
                        o["name"].as_str().unwrap_or("").to_string(),
                        o["kind"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    {
        let mut stats = shared.stats.lock().unwrap();
        for (_, _, kind) in &options {
            stats.permission_option_kinds.insert(kind.clone());
        }
    }
    let title = params["toolCall"]["title"].as_str().unwrap_or("(untitled)");

    if shared.cancelled.load(Ordering::SeqCst) {
        return json!({ "outcome": { "outcome": "cancelled" } });
    }

    let pick = |prefer: &str, fallback: &str| {
        options
            .iter()
            .find(|o| o.2 == prefer)
            .or_else(|| options.iter().find(|o| o.2.starts_with(fallback)))
            .map(|o| o.0.clone())
    };

    let chosen = match shared.policy {
        Policy::Allow => pick("allow_once", "allow"),
        Policy::Reject => pick("reject_once", "reject"),
        Policy::Ask => {
            let _guard = ASK_LOCK.lock().await;
            let mut menu = format!("[permission] {title}\n");
            for (i, (_, name, kind)) in options.iter().enumerate() {
                menu += &format!("  {}) {name}  ({kind})\n", i + 1);
            }
            menu += "  c) cancel\nEnter a number: ";
            print!("\n{menu}");
            let _ = std::io::stdout().flush();
            let line = tokio::task::spawn_blocking(|| {
                let mut s = String::new();
                let _ = std::io::stdin().read_line(&mut s);
                s
            })
            .await
            .unwrap_or_default();
            line.trim().parse::<usize>().ok().and_then(|n| options.get(n.wrapping_sub(1))).map(|o| o.0.clone())
        }
    };

    match chosen {
        Some(option_id) => {
            shared.event(&format!("[permission] {title} → {option_id}"));
            json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
        }
        None => {
            shared.event(&format!("[permission] {title} → cancelled"));
            json!({ "outcome": { "outcome": "cancelled" } })
        }
    }
}

/// Refuse reads and writes outside the working directory
fn inside_cwd(shared: &Shared, path: &Path) -> Result<PathBuf, String> {
    let cwd = shared.cwd.canonicalize().map_err(|e| e.to_string())?;
    let parent = path.parent().ok_or("no parent directory")?;
    let parent = parent.canonicalize().map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent.starts_with(&cwd) {
        return Err(format!("outside the working directory: {}", path.display()));
    }
    Ok(parent.join(path.file_name().ok_or("no file name")?))
}

fn read_text_file(shared: &Shared, params: &Value) -> Result<String, String> {
    let path = inside_cwd(shared, Path::new(params["path"].as_str().ok_or("missing path")?))?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let line = params["line"].as_u64().unwrap_or(1).max(1) as usize;
    let limit = params["limit"].as_u64().map(|n| n as usize);
    let lines = text.split_inclusive('\n').skip(line - 1);
    Ok(match limit {
        Some(n) => lines.take(n).collect(),
        None => lines.collect(),
    })
}

fn write_text_file(shared: &Shared, params: &Value) -> Result<(), String> {
    let path = inside_cwd(shared, Path::new(params["path"].as_str().ok_or("missing path")?))?;
    let content = params["content"].as_str().ok_or("missing content")?;
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    shared.event(&format!("[fs] wrote {}", path.display()));
    Ok(())
}
