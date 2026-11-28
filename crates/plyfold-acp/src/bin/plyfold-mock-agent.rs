//! Mock ACP agent for tests and UI development (spends no tokens)
//!
//! Behavior depends on words in the prompt:
//! - `permission` : asks for permission before writing a file. If allowed, writes `mock-output.txt` and returns a diff
//! - `hang`       : does not finish until session/cancel arrives
//! - `silent`     : stays silent for 3 seconds, then answers (for testing stall detection)
//! - otherwise    : answers `echo: <prompt>`
//!
//! History is kept in `<cwd>/.plyfold-mock/<sessionId>.jsonl` and replayed on session/load.
//! A pointer in the temp dir lets a later process `session/fork` or `session/list` that id (agents persist sessions outside the worktree).
//! Also reports config options (model / effort / mode) and usage (usage_update, per-turn usage).
//! `initialize` advertises HTTP MCP and not SSE, so a test can tell those apart.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;

#[derive(Default)]
struct State {
    out: Mutex<()>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    cancelled: Mutex<HashSet<String>>,
    cwds: Mutex<HashMap<String, PathBuf>>,
    seq: AtomicU64,
    /// sessionId → (configId → value)
    config: Mutex<HashMap<String, HashMap<String, String>>>,
    used: AtomicU64,
    /// MOCK_AUTH=1: session/new and session/load refuse until `authenticate` has been called
    authed: std::sync::atomic::AtomicBool,
}

const CONFIG: &[(&str, &str, &[&str])] = &[
    ("model", "model", &["mock-large", "mock-small"]),
    ("effort", "thought_level", &["low", "medium", "high"]),
    ("mode", "mode", &["default", "plan", "auto", "acceptEdits", "bypassPermissions"]),
];

fn config_options(values: &HashMap<String, String>) -> Value {
    Value::Array(
        CONFIG
            .iter()
            .map(|(id, cat, opts)| {
                json!({
                    "id": id, "name": id, "category": cat, "type": "select",
                    "currentValue": values.get(*id).cloned().unwrap_or_else(|| opts[0].to_string()),
                    "options": opts.iter().map(|o| json!({"value": o, "name": o})).collect::<Vec<_>>()
                })
            })
            .collect(),
    )
}

impl State {
    fn send(&self, v: Value) {
        let _g = self.out.lock().unwrap();
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{v}");
        let _ = stdout.flush();
    }

    fn history_path(&self, sid: &str) -> Option<PathBuf> {
        let cwd = self.cwds.lock().unwrap().get(sid).cloned()?;
        Some(cwd.join(".plyfold-mock").join(format!("{sid}.jsonl")))
    }

    fn update(&self, sid: &str, update: Value) {
        if let Some(p) = self.history_path(sid) {
            let _ = std::fs::create_dir_all(p.parent().unwrap());
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "{update}");
            }
        }
        self.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": update}}));
    }

    async fn request(&self, method: &str, params: Value) -> Value {
        let id = 1_000_000 + self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        rx.await.unwrap_or(Value::Null)
    }

    fn is_cancelled(&self, sid: &str) -> bool {
        self.cancelled.lock().unwrap().contains(sid)
    }

    /// Remember where this session's history file lives, including for a process that starts later
    fn bind(&self, sid: &str, cwd: PathBuf) {
        let pointer = std::env::temp_dir().join("plyfold-mock-sessions").join(sid);
        if let Some(parent) = pointer.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&pointer, cwd.display().to_string());
        self.cwds.lock().unwrap().insert(sid.to_string(), cwd);
    }

    fn known(&self, sid: &str) -> bool {
        self.cwds.lock().unwrap().contains_key(sid) || std::env::temp_dir().join("plyfold-mock-sessions").join(sid).is_file()
    }
}

/// The history file in this directory, or the one recorded when the session was created in another directory
fn history_file(sid: &str, cwd: &std::path::Path) -> Option<PathBuf> {
    let local = cwd.join(".plyfold-mock").join(format!("{sid}.jsonl"));
    if local.is_file() {
        return Some(local);
    }
    let pointer = std::env::temp_dir().join("plyfold-mock-sessions").join(sid);
    let dir = std::fs::read_to_string(pointer).ok()?;
    let path = PathBuf::from(dir.trim()).join(".plyfold-mock").join(format!("{sid}.jsonl"));
    path.is_file().then_some(path)
}

fn same_dir(stored: &str, asked: &std::path::Path) -> bool {
    let stored = PathBuf::from(stored);
    if stored == asked {
        return true;
    }
    match (stored.canonicalize(), asked.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The first thing the user said, used as the title session/list reports
fn title_of(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["sessionUpdate"] != "user_message_chunk" {
            continue;
        }
        let title = v["content"]["text"].as_str().unwrap_or("").trim();
        if !title.is_empty() {
            return Some(title.chars().take(80).collect());
        }
    }
    None
}

fn text_chunk(kind: &str, text: &str) -> Value {
    json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}})
}

async fn prompt(st: Arc<State>, id: Value, params: Value) {
    let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
    st.cancelled.lock().unwrap().remove(&sid);
    let text: String = params["prompt"].as_array().map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("")).unwrap_or_default();
    st.update(&sid, text_chunk("user_message_chunk", &text));

    let stop = if text.contains("permission") {
        let kind = if text.contains("fetch") {
            "fetch"
        } else if text.contains("skill") {
            "other"
        } else if text.contains("read") {
            "read"
        } else {
            "edit"
        };
        permission_flow(&st, &sid, kind, &text).await
    } else if text.contains("hang") {
        st.update(&sid, text_chunk("agent_message_chunk", "working forever..."));
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if st.is_cancelled(&sid) {
                break "cancelled";
            }
        }
    } else {
        if text.contains("silent") {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        // "env NAME": answer with the value of an environment variable the agent was started with.
        // "limit": started with MOCK_LIMITED=1, pass on a rate limit error the way Claude Code does
        let reply = match text.strip_prefix("env ") {
            Some(var) => format!("{var}={}", std::env::var(var.trim()).unwrap_or_default()),
            None if text.contains("limit") && std::env::var("MOCK_LIMITED").as_deref() == Ok("1") => {
                r#"API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}"#.to_string()
            }
            None => format!("echo: {text}"),
        };
        st.update(&sid, text_chunk("agent_message_chunk", &reply));
        "end_turn"
    };
    let output = (text.len() as u64 / 2).max(1);
    let used = st.used.fetch_add(100 + output, Ordering::SeqCst) + 100 + output;
    st.update(
        &sid,
        json!({"sessionUpdate": "usage_update", "used": used, "size": 100_000, "cost": {"amount": used as f64 / 1e6, "currency": "USD"},
               "_meta": {"_claude/model": "mock-large-2026"}}),
    );
    st.send(json!({"jsonrpc": "2.0", "id": id, "result": {"stopReason": stop,
        "usage": {"inputTokens": 100, "outputTokens": output, "cachedReadTokens": 50, "totalTokens": 100 + output}}}));
}

/// A tool call that needs permission: "edit" writes mock-output.txt when allowed, "fetch" only reports it fetched a page
/// "read" reads notes.txt in the session folder; with "outside" in the prompt it reads a path outside it, with
/// "with-command" it carries a shell command under the read label, with "always-only" the only allow is allow_always
async fn permission_flow(st: &State, sid: &str, kind: &str, text: &str) -> &'static str {
    let n = st.seq.fetch_add(1, Ordering::SeqCst);
    let tool_id = format!("mock-tool-{n}");
    let cwd = st.cwds.lock().unwrap().get(sid).cloned().unwrap_or_else(|| PathBuf::from("."));
    let path = cwd.join("mock-output.txt");
    let title = match kind {
        "fetch" => "Fetch https://example.invalid",
        "read" => "Read notes.txt",
        "other" => "Load skill: notes",
        _ => "Write mock-output.txt",
    };
    st.update(sid, json!({"sessionUpdate": "tool_call", "toolCallId": tool_id, "title": title, "kind": kind, "status": "pending"}));
    let target = if text.contains("outside") { cwd.parent().unwrap_or(&cwd).join("outside.txt") } else { cwd.join("notes.txt") };
    let mut call = json!({"toolCallId": tool_id, "title": title, "kind": kind, "locations": [{"path": target}]});
    if kind == "other" {
        call["name"] = json!("Skill");
    }
    if text.contains("with-command") {
        call["rawInput"] = json!({"command": "cat ~/.ssh/id_ed25519"});
    }
    let options = if text.contains("always-only") {
        json!([{"optionId": "always", "name": "Always allow", "kind": "allow_always"}, {"optionId": "reject", "name": "Reject", "kind": "reject_once"}])
    } else {
        json!([{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, {"optionId": "reject", "name": "Reject", "kind": "reject_once"}])
    };
    let resp = st
        .request(
            "session/request_permission",
            json!({
                "sessionId": sid,
                "toolCall": call,
                "options": options
            }),
        )
        .await;
    let outcome = &resp["outcome"];
    if outcome["outcome"] == "cancelled" || st.is_cancelled(sid) {
        st.update(sid, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "failed"}));
        return "cancelled";
    }
    let allowed = outcome["optionId"] == "allow" || outcome["optionId"] == "always";
    if allowed && kind == "other" {
        st.update(sid, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "completed"}));
        st.update(sid, text_chunk("agent_message_chunk", "loaded the skill"));
    } else if allowed && kind == "read" {
        st.update(sid, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "completed"}));
        st.update(sid, text_chunk("agent_message_chunk", "read the notes"));
    } else if allowed && kind == "fetch" {
        st.update(sid, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "completed"}));
        st.update(sid, text_chunk("agent_message_chunk", "fetched the page"));
    } else if allowed {
        let old = std::fs::read_to_string(&path).ok();
        let new = format!("written by mock agent ({n})\n");
        let _ = std::fs::write(&path, &new);
        st.update(
            sid,
            json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "completed",
                   "content": [{"type": "diff", "path": path, "oldText": old, "newText": new}]}),
        );
        st.update(sid, text_chunk("agent_message_chunk", "wrote mock-output.txt"));
    } else {
        st.update(sid, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "failed"}));
        st.update(sid, text_chunk("agent_message_chunk", "permission rejected"));
    }
    "end_turn"
}

fn needs_auth() -> bool {
    std::env::var("MOCK_AUTH").as_deref() == Ok("1")
}

fn handle_request(st: &Arc<State>, id: Value, method: &str, params: Value) {
    let reply = |result: Value| st.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    match method {
        "initialize" => reply(json!({
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": true, "promptCapabilities": {}, "mcpCapabilities": {"http": true}, "sessionCapabilities": {"fork": {}, "list": {}}},
            "authMethods": if needs_auth() { json!([{"id": "oauth-personal", "name": "Log in with Google"}]) } else { json!([]) },
            "agentInfo": {"name": "plyfold-mock-agent", "version": env!("CARGO_PKG_VERSION")}
        })),
        "authenticate" => {
            st.authed.store(true, Ordering::SeqCst);
            reply(json!({}));
        }
        "session/new" | "session/load" if needs_auth() && !st.authed.load(Ordering::SeqCst) => {
            st.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": "Authentication required"}}));
        }
        "session/new" => {
            let n = st.seq.fetch_add(1, Ordering::SeqCst);
            let sid = format!("mock-{}-{n}", std::process::id());
            let cwd = PathBuf::from(params["cwd"].as_str().unwrap_or("."));
            st.bind(&sid, cwd);
            st.config.lock().unwrap().insert(sid.clone(), HashMap::new());
            reply(json!({
                "sessionId": sid,
                "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]},
                "configOptions": config_options(&HashMap::new())
            }));
        }
        "session/load" => {
            let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
            let cwd = PathBuf::from(params["cwd"].as_str().unwrap_or("."));
            let Some(path) = history_file(&sid, &cwd) else {
                st.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32002, "message": "session not found"}}));
                return;
            };
            let Ok(text) = std::fs::read_to_string(&path) else {
                st.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32002, "message": "session not found"}}));
                return;
            };
            // Register the cwd only after the replay, so the replay is not appended to the history
            for line in text.lines() {
                if let Ok(update) = serde_json::from_str::<Value>(line) {
                    st.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": update}}));
                }
            }
            // A later load uses the new directory, so the history has to live there too
            let dest = cwd.join(".plyfold-mock").join(format!("{sid}.jsonl"));
            if path != dest {
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::copy(&path, &dest);
            }
            st.bind(&sid, cwd);
            reply(json!({}));
        }
        "session/list" => {
            let want = params["cwd"].as_str().map(str::to_string);
            let mut sessions = Vec::new();
            let dir = std::env::temp_dir().join("plyfold-mock-sessions");
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for ent in rd.flatten() {
                    let sid = ent.file_name().to_string_lossy().to_string();
                    let Ok(cwd) = std::fs::read_to_string(ent.path()) else { continue };
                    let cwd = cwd.trim();
                    if let Some(want) = &want
                        && !same_dir(cwd, std::path::Path::new(want))
                    {
                        continue;
                    }
                    let hist = std::path::PathBuf::from(cwd).join(".plyfold-mock").join(format!("{sid}.jsonl"));
                    let mut obj = json!({"sessionId": sid, "cwd": cwd});
                    if let Some(title) = title_of(&hist) {
                        obj["title"] = json!(title);
                    }
                    sessions.push(obj);
                }
            }
            reply(json!({ "sessions": sessions }));
        }
        "session/fork" => {
            let old = params["sessionId"].as_str().unwrap_or_default().to_string();
            if !st.known(&old) {
                st.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32002, "message": "session not found"}}));
                return;
            }
            let n = st.seq.fetch_add(1, Ordering::SeqCst);
            let sid = format!("mock-{}-{n}", std::process::id());
            let cwd = PathBuf::from(params["cwd"].as_str().unwrap_or("."));
            if let Some(src) = st.history_path(&old).filter(|p| p.is_file()).or_else(|| {
                let pointer = std::env::temp_dir().join("plyfold-mock-sessions").join(&old);
                let dir = std::fs::read_to_string(pointer).ok()?;
                let path = PathBuf::from(dir.trim()).join(".plyfold-mock").join(format!("{old}.jsonl"));
                path.is_file().then_some(path)
            }) {
                let dest_dir = cwd.join(".plyfold-mock");
                let _ = std::fs::create_dir_all(&dest_dir);
                let _ = std::fs::copy(src, dest_dir.join(format!("{sid}.jsonl")));
            }
            let values = st.config.lock().unwrap().get(&old).cloned().unwrap_or_default();
            st.config.lock().unwrap().insert(sid.clone(), values.clone());
            st.bind(&sid, cwd);
            reply(json!({
                "sessionId": sid,
                "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]},
                "configOptions": config_options(&values)
            }));
        }
        "session/set_mode" => {
            let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
            st.update(&sid, json!({"sessionUpdate": "current_mode_update", "currentModeId": params["modeId"]}));
            reply(json!({}));
        }
        "session/prompt" => {
            tokio::spawn(prompt(st.clone(), id, params));
        }
        "session/set_config_option" => {
            let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
            let cid = params["configId"].as_str().unwrap_or_default().to_string();
            let val = params["value"].as_str().unwrap_or_default().to_string();
            let Some((_, _, opts)) = CONFIG.iter().find(|c| c.0 == cid) else {
                st.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "unknown config option"}}));
                return;
            };
            if !opts.contains(&val.as_str()) {
                st.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "invalid value"}}));
                return;
            }
            let opts_json = {
                let mut cfg = st.config.lock().unwrap();
                let values = cfg.entry(sid).or_default();
                values.insert(cid, val);
                config_options(values)
            };
            reply(json!({ "configOptions": opts_json }));
        }
        _ => st.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}})),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let st = Arc::new(State::default());
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let method = msg["method"].as_str().map(str::to_string);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match (method, msg.get("id").cloned()) {
            (Some(m), Some(id)) => handle_request(&st, id, &m, params),
            (Some(m), None) if m == "session/cancel" => {
                if let Some(sid) = params["sessionId"].as_str() {
                    st.cancelled.lock().unwrap().insert(sid.to_string());
                }
            }
            (None, Some(id)) => {
                if let Some(tx) = id.as_u64().and_then(|i| st.pending.lock().unwrap().remove(&i)) {
                    let _ = tx.send(msg.get("result").cloned().unwrap_or(Value::Null));
                }
            }
            _ => {}
        }
    }
}
