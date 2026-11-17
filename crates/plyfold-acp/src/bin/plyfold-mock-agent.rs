//! Mock ACP agent for tests and UI development (spends no tokens)
//!
//! Behavior depends on words in the prompt:
//! - `permission` : asks for permission before writing a file. If allowed, writes `mock-output.txt` and returns a diff
//! - `hang`       : does not finish until session/cancel arrives
//! - `silent`     : stays silent for 3 seconds, then answers (for testing stall detection)
//! - otherwise    : answers `echo: <prompt>`
//!
//! History is kept in `<cwd>/.plyfold-mock/<sessionId>.jsonl` and replayed on session/load.
//! Also reports config options (model / effort / mode) and usage (usage_update, per-turn usage).

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
}

const CONFIG: &[(&str, &str, &[&str])] = &[
    ("model", "model", &["mock-large", "mock-small"]),
    ("effort", "thought_level", &["low", "medium", "high"]),
    ("mode", "mode", &["default", "plan", "auto"]),
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
}

fn text_chunk(kind: &str, text: &str) -> Value {
    json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}})
}

async fn prompt(st: Arc<State>, id: Value, params: Value) {
    let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
    st.cancelled.lock().unwrap().remove(&sid);
    let text: String = params["prompt"]
        .as_array()
        .map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(""))
        .unwrap_or_default();
    st.update(&sid, text_chunk("user_message_chunk", &text));

    let stop = if text.contains("permission") {
        permission_flow(&st, &sid).await
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
        for part in ["echo: ", text.as_str()] {
            st.update(&sid, text_chunk("agent_message_chunk", part));
        }
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

async fn permission_flow(st: &State, sid: &str) -> &'static str {
    let n = st.seq.fetch_add(1, Ordering::SeqCst);
    let tool_id = format!("mock-tool-{n}");
    let cwd = st.cwds.lock().unwrap().get(sid).cloned().unwrap_or_else(|| PathBuf::from("."));
    let path = cwd.join("mock-output.txt");
    st.update(
        sid,
        json!({"sessionUpdate": "tool_call", "toolCallId": tool_id, "title": "Write mock-output.txt", "kind": "edit", "status": "pending"}),
    );
    let resp = st
        .request(
            "session/request_permission",
            json!({
                "sessionId": sid,
                "toolCall": {"toolCallId": tool_id, "title": "Write mock-output.txt", "kind": "edit"},
                "options": [
                    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "reject", "name": "Reject", "kind": "reject_once"}
                ]
            }),
        )
        .await;
    let outcome = &resp["outcome"];
    if outcome["outcome"] == "cancelled" || st.is_cancelled(sid) {
        st.update(sid, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "failed"}));
        return "cancelled";
    }
    if outcome["optionId"] == "allow" {
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

fn handle_request(st: &Arc<State>, id: Value, method: &str, params: Value) {
    let reply = |result: Value| st.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    match method {
        "initialize" => reply(json!({
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": true, "promptCapabilities": {}, "mcpCapabilities": {}},
            "authMethods": [],
            "agentInfo": {"name": "plyfold-mock-agent", "version": env!("CARGO_PKG_VERSION")}
        })),
        "session/new" => {
            let n = st.seq.fetch_add(1, Ordering::SeqCst);
            let sid = format!("mock-{}-{n}", std::process::id());
            let cwd = PathBuf::from(params["cwd"].as_str().unwrap_or("."));
            st.cwds.lock().unwrap().insert(sid.clone(), cwd);
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
            let path = cwd.join(".plyfold-mock").join(format!("{sid}.jsonl"));
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
            st.cwds.lock().unwrap().insert(sid, cwd);
            reply(json!({}));
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
