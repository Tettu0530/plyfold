use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::{Value, json};

use crate::config::{self, Config, Launch};
use crate::conn::{Conn, RpcError};
use crate::handler::{self, Policy, Shared, Stats};

#[derive(Clone)]
pub struct Opts {
    pub root: PathBuf,
    pub policy: Policy,
    pub quiet: bool,
    pub cwd: Option<PathBuf>,
    pub auth: Option<String>,
    /// session/new の直後に session/set_mode で切り替えるモード
    pub mode: Option<String>,
}

pub struct Session {
    pub conn: Arc<Conn>,
    pub shared: Arc<Shared>,
    pub init: Value,
    pub run_dir: PathBuf,
    pub launch: Launch,
    pub cwd: PathBuf,
    pub mode: Option<String>,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

const INIT_TIMEOUT: Duration = Duration::from_secs(180); // npx の初回ダウンロードを見込む
const SESSION_TIMEOUT: Duration = Duration::from_secs(120);

pub async fn start(cfg: &Config, target: &str, opts: &Opts, kind: &str) -> Result<Session> {
    let launch = cfg.resolve(target, &config::state_dir())?;
    let runs = opts.root.join("probe-runs");
    let run_dir = runs.join(format!("{}-{target}-{kind}", now_ms()));
    std::fs::create_dir_all(&run_dir)?;
    let cwd = match &opts.cwd {
        Some(c) => c.clone(),
        None => runs.join("workspace"),
    };
    std::fs::create_dir_all(&cwd)?;
    let cwd = cwd.canonicalize()?;

    if !opts.quiet {
        println!("== {target}（エージェント: {}）", launch.agent);
        println!("   起動: {} {}", launch.command, launch.args.join(" "));
        if !launch.env_summary.is_empty() {
            println!("   環境変数: {}", launch.env_summary.join(", "));
        }
        if !launch.env_remove.is_empty() {
            println!("   引き継がない環境変数: {}", launch.env_remove.join(", "));
        }
        println!("   作業ディレクトリ: {}", cwd.display());
        println!("   記録: {}", run_dir.display());
    }

    let (conn, rx) = Conn::spawn(&launch, &cwd, &run_dir).await?;
    let shared = Shared::new(target.to_string(), opts.policy, cwd.clone(), opts.quiet);
    handler::spawn_dispatcher(conn.clone(), rx, shared.clone());

    let init = conn
        .request_timeout(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": false
                },
                "clientInfo": { "name": "plyfold-probe", "title": "Plyfold Probe", "version": env!("CARGO_PKG_VERSION") }
            }),
            INIT_TIMEOUT,
        )
        .await
        .with_context(|| format!("initialize に失敗（stderr: {}）", run_dir.join("stderr.log").display()))?;

    if let Some(method) = &opts.auth {
        conn.request_timeout("authenticate", json!({ "methodId": method }), SESSION_TIMEOUT)
            .await
            .context("authenticate に失敗")?;
    }

    Ok(Session { conn, shared, init, run_dir, launch, cwd, mode: opts.mode.clone() })
}

impl Session {
    pub async fn new_session(&self) -> Result<Value, RpcError> {
        let r = self
            .conn
            .request_timeout("session/new", json!({ "cwd": self.cwd, "mcpServers": [] }), SESSION_TIMEOUT)
            .await;
        if let Err(e) = &r
            && e.code == RpcError::AUTH_REQUIRED {
                let methods: Vec<String> = auth_methods(&self.init);
                eprintln!("認証が必要です。使える方法: {}（--auth <id> で指定）", methods.join(", "));
            }
        r
    }

    fn total_updates(&self) -> u64 {
        self.shared.stats.lock().unwrap().updates.values().sum()
    }

    /// session/load（なければ session/resume）で既存セッションを開き直す
    pub async fn reopen(&self, session_id: &str) -> Result<(String, u64)> {
        let caps = &self.init["agentCapabilities"];
        let method = if caps["loadSession"].as_bool() == Some(true) {
            "session/load"
        } else if !caps["sessionCapabilities"]["resume"].is_null() {
            "session/resume"
        } else {
            bail!("このエージェントは session/load も session/resume も対応していません");
        };
        let before = self.total_updates();
        self.conn
            .request_timeout(
                method,
                json!({ "sessionId": session_id, "cwd": self.cwd, "mcpServers": [] }),
                SESSION_TIMEOUT,
            )
            .await?;
        // 履歴の再送が通知で届き切るのを少し待つ
        tokio::time::sleep(Duration::from_millis(500)).await;
        Ok((method.to_string(), self.total_updates() - before))
    }
}

fn auth_methods(init: &Value) -> Vec<String> {
    init["authMethods"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    let ty = m["type"].as_str().unwrap_or("agent");
                    format!("{}[{ty}]", m["id"].as_str().unwrap_or("?"))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn object_keys(v: &Value) -> Vec<String> {
    v.as_object()
        .map(|o| o.iter().filter(|(k, v)| !v.is_null() && *k != "_meta").map(|(k, _)| k.clone()).collect())
        .unwrap_or_default()
}

fn true_keys(v: &Value) -> Vec<String> {
    v.as_object()
        .map(|o| o.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default()
}

fn ids(v: &Value, id_field: &str) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x[id_field].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- caps

#[derive(Debug, Serialize, Default)]
pub struct CapsRow {
    pub target: String,
    pub agent_info: String,
    pub protocol: String,
    pub load_session: bool,
    pub session_caps: Vec<String>,
    pub prompt_caps: Vec<String>,
    pub mcp_caps: Vec<String>,
    pub auth: Vec<String>,
    pub new_session: String,
    pub modes: Vec<String>,
    pub config_options: Vec<String>,
    pub models: Vec<String>,
    pub session_list: String,
    pub error: Option<String>,
}

pub async fn caps(cfg: &Config, target: &str, opts: &Opts) -> Result<CapsRow> {
    let s = start(cfg, target, opts, "caps").await?;
    let init = &s.init;
    let ac = &init["agentCapabilities"];
    let mut row = CapsRow {
        target: target.to_string(),
        agent_info: format!(
            "{} {}",
            init["agentInfo"]["name"].as_str().unwrap_or("?"),
            init["agentInfo"]["version"].as_str().unwrap_or("")
        ),
        protocol: init["protocolVersion"].to_string(),
        load_session: ac["loadSession"].as_bool().unwrap_or(false),
        session_caps: object_keys(&ac["sessionCapabilities"]),
        prompt_caps: true_keys(&ac["promptCapabilities"]),
        mcp_caps: true_keys(&ac["mcpCapabilities"]),
        auth: auth_methods(init),
        ..Default::default()
    };

    let mut new_session = Value::Null;
    match s.new_session().await {
        Ok(r) => {
            row.new_session = "ok".into();
            row.modes = ids(&r["modes"]["availableModes"], "id");
            row.config_options = ids(&r["configOptions"], "id");
            row.models = ids(&r["models"]["availableModels"], "modelId");
            new_session = r;
        }
        Err(e) => row.new_session = format!("失敗: {e}"),
    }

    let mut list = Value::Null;
    if !ac["sessionCapabilities"]["list"].is_null() {
        match s.conn.request_timeout("session/list", json!({ "cwd": s.cwd }), SESSION_TIMEOUT).await {
            Ok(r) => {
                row.session_list = format!("{} 件", r["sessions"].as_array().map(|a| a.len()).unwrap_or(0));
                list = r;
            }
            Err(e) => row.session_list = format!("失敗: {e}"),
        }
    } else {
        row.session_list = "非対応".into();
    }

    std::fs::write(
        s.run_dir.join("caps.json"),
        serde_json::to_string_pretty(&json!({ "initialize": init, "session/new": new_session, "session/list": list }))?,
    )?;
    s.conn.shutdown().await;

    if !opts.quiet {
        print_caps(&row);
    }
    Ok(row)
}

fn join_or(v: &[String], empty: &str) -> String {
    if v.is_empty() { empty.to_string() } else { v.join(", ") }
}

fn print_caps(r: &CapsRow) {
    println!();
    println!("エージェント        {}", r.agent_info);
    println!("プロトコル          v{}", r.protocol);
    println!("session/load        {}", if r.load_session { "対応" } else { "非対応" });
    println!("セッション機能      {}", join_or(&r.session_caps, "なし"));
    println!("プロンプト          text{}", r.prompt_caps.iter().map(|c| format!(", {c}")).collect::<String>());
    println!("MCP                 {}", join_or(&r.mcp_caps, "stdio のみ"));
    println!("認証方法            {}", join_or(&r.auth, "なし"));
    println!("session/new         {}", r.new_session);
    println!("モード              {}", join_or(&r.modes, "なし"));
    println!("設定項目            {}", join_or(&r.config_options, "なし"));
    println!("モデル              {}", join_or(&r.models, "なし"));
    println!("session/list        {}", r.session_list);
}

// ---------------------------------------------------------------- run

#[derive(Debug, Serialize)]
pub struct RunSummary {
    pub target: String,
    pub agent: String,
    pub session_id: Option<String>,
    pub reopen: Option<String>,
    pub stop_reason: Option<String>,
    pub elapsed_ms: u128,
    pub cancel_latency_ms: Option<u128>,
    pub stats: Stats,
    pub error: Option<String>,
    pub run_dir: PathBuf,
}

pub async fn run(
    cfg: &Config,
    target: &str,
    opts: &Opts,
    prompt: Option<String>,
    cancel_after: Option<u64>,
    session_id: Option<String>,
) -> Result<RunSummary> {
    let s = start(cfg, target, opts, "run").await?;
    let started = Instant::now();
    let mut summary = RunSummary {
        target: target.to_string(),
        agent: s.launch.agent.clone(),
        session_id: None,
        reopen: None,
        stop_reason: None,
        elapsed_ms: 0,
        cancel_latency_ms: None,
        stats: Stats::default(),
        error: None,
        run_dir: s.run_dir.clone(),
    };

    let result = run_inner(&s, &mut summary, prompt, cancel_after, session_id).await;
    if let Err(e) = result {
        summary.error = Some(format!("{e:#}"));
    }
    summary.elapsed_ms = started.elapsed().as_millis();
    summary.stats = s.shared.stats.lock().unwrap().clone();
    std::fs::write(s.run_dir.join("summary.json"), serde_json::to_string_pretty(&summary)?)?;
    s.conn.shutdown().await;

    if !opts.quiet {
        println!("\n\n== 結果");
        println!("{}", serde_json::to_string_pretty(&summary)?);
        if let Some(id) = &summary.session_id {
            println!("\n開き直す: plyfold-probe run {target} --session {id}");
        }
    }
    Ok(summary)
}

async fn run_inner(
    s: &Session,
    summary: &mut RunSummary,
    prompt: Option<String>,
    cancel_after: Option<u64>,
    session_id: Option<String>,
) -> Result<()> {
    let sid = match session_id {
        Some(id) => {
            let (method, replayed) = s.reopen(&id).await?;
            let msg = format!("{method} で開き直し、履歴の通知を {replayed} 件受信");
            s.shared.note(msg.clone());
            summary.reopen = Some(msg);
            id
        }
        None => {
            let r = s.new_session().await?;
            r["sessionId"].as_str().context("sessionId がありません")?.to_string()
        }
    };
    summary.session_id = Some(sid.clone());

    if let Some(mode) = &s.mode {
        s.conn
            .request_timeout("session/set_mode", json!({ "sessionId": sid, "modeId": mode }), SESSION_TIMEOUT)
            .await?;
        s.shared.note(format!("モードを {mode} に切り替え"));
    }

    let Some(prompt) = prompt else { return Ok(()) };

    let cancel_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let send_cancel = {
        let conn = s.conn.clone();
        let shared = s.shared.clone();
        let cancel_at = cancel_at.clone();
        let sid = sid.clone();
        move || {
            let conn = conn.clone();
            let shared = shared.clone();
            let cancel_at = cancel_at.clone();
            let sid = sid.clone();
            async move {
                if shared.cancelled.swap(true, Ordering::SeqCst) {
                    return;
                }
                *cancel_at.lock().unwrap() = Some(Instant::now());
                shared.note("session/cancel を送信");
                let _ = conn.notify("session/cancel", json!({ "sessionId": sid })).await;
            }
        }
    };

    let timer = cancel_after.map(|secs| {
        let f = send_cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            f().await;
        })
    });
    let ctrl_c = (!s.shared.quiet).then(|| {
        let f = send_cancel.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                f().await;
            }
        })
    });

    let r = s
        .conn
        .request("session/prompt", json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": prompt }] }))
        .await;

    for t in [timer, ctrl_c].into_iter().flatten() {
        t.abort();
    }
    if let Some(at) = *cancel_at.lock().unwrap() {
        summary.cancel_latency_ms = Some(at.elapsed().as_millis());
    }
    let r = r?;
    summary.stop_reason = r["stopReason"].as_str().map(str::to_string);
    Ok(())
}

// ---------------------------------------------------------------- parallel

pub async fn parallel(cfg: Arc<Config>, targets: Vec<String>, opts: Opts, prompt: String) -> Result<()> {
    if opts.policy == Policy::Ask {
        bail!("parallel では --permission allow か reject を指定してください");
    }
    let opts = Opts { quiet: true, ..opts };
    let mut tasks = Vec::new();
    for t in targets {
        let cfg = cfg.clone();
        let opts = opts.clone();
        let prompt = prompt.clone();
        tasks.push(tokio::spawn(async move {
            let r = run(&cfg, &t, &opts, Some(prompt), None, None).await;
            (t, r)
        }));
    }
    println!("\n| プロファイル | 結果 | 本文文字数 | 時間 | 記録 |");
    println!("|---|---|---|---|---|");
    for task in tasks {
        let (t, r) = task.await?;
        match r {
            Ok(s) => println!(
                "| {t} | {} | {} | {:.1}s | {} |",
                s.error.as_deref().map(|e| format!("エラー: {e}")).or(s.stop_reason.clone()).unwrap_or_default(),
                s.stats.agent_text_chars,
                s.elapsed_ms as f64 / 1000.0,
                s.run_dir.display()
            ),
            Err(e) => println!("| {t} | 起動失敗: {e:#} | | | |"),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- matrix

pub async fn matrix(cfg: &Config, targets: Vec<String>, opts: &Opts) -> Result<PathBuf> {
    let opts = Opts { quiet: true, ..opts.clone() };
    let targets = if targets.is_empty() { cfg.agents.keys().cloned().collect() } else { targets };
    let mut rows = Vec::new();
    for t in &targets {
        eprintln!("調査中: {t}");
        let row = match caps(cfg, t, &opts).await {
            Ok(r) => r,
            Err(e) => CapsRow { target: t.clone(), error: Some(format!("{e:#}")), ..Default::default() },
        };
        rows.push(row);
    }

    let fields: [(&str, fn(&CapsRow) -> String); 12] = [
        ("エージェント", |r| r.agent_info.clone()),
        ("プロトコル", |r| r.protocol.clone()),
        ("session/load", |r| if r.load_session { "○".into() } else { "×".into() }),
        ("セッション機能", |r| join_or(&r.session_caps, "-")),
        ("プロンプト", |r| join_or(&r.prompt_caps, "text のみ")),
        ("MCP", |r| join_or(&r.mcp_caps, "stdio のみ")),
        ("認証方法", |r| join_or(&r.auth, "-")),
        ("session/new", |r| r.new_session.clone()),
        ("モード", |r| join_or(&r.modes, "-")),
        ("設定項目", |r| join_or(&r.config_options, "-")),
        ("モデル", |r| summarize_models(&r.models)),
        ("session/list", |r| r.session_list.clone()),
    ];

    let mut md = String::from("# ACP 対応状況（initialize / session/new 時点）\n\n");
    md += &format!("| 項目 | {} |\n", targets.join(" | "));
    md += &format!("|---|{}\n", "---|".repeat(targets.len()));
    for (name, f) in fields {
        let cells: Vec<String> = rows
            .iter()
            .map(|r| if r.error.is_some() { "-".into() } else { f(r).replace('|', "\\|") })
            .collect();
        md += &format!("| {name} | {} |\n", cells.join(" | "));
    }
    let errors: Vec<&CapsRow> = rows.iter().filter(|r| r.error.is_some()).collect();
    if !errors.is_empty() {
        md += "\n## 起動できなかったもの\n\n";
        for r in errors {
            md += &format!("- **{}**: {}\n", r.target, r.error.as_deref().unwrap_or(""));
        }
    }
    md += "\n権限確認・差分・中断は `plyfold-probe run` で確かめる（summary.json に記録される）。\n";

    let path = opts.root.join("probe-runs").join("matrix.md");
    std::fs::write(&path, &md)?;
    println!("{md}");
    Ok(path)
}

/// "gpt-x[high]" のような effort 違いをまとめ、数と代表例だけにする
fn summarize_models(models: &[String]) -> String {
    if models.is_empty() {
        return "-".into();
    }
    let mut base: Vec<String> = Vec::new();
    for m in models {
        let b = m.split('[').next().unwrap_or(m).to_string();
        if !base.contains(&b) {
            base.push(b);
        }
    }
    let head: Vec<&str> = base.iter().take(4).map(String::as_str).collect();
    let more = if base.len() > 4 { " ほか" } else { "" };
    format!("{} 種（{}{more}）", base.len(), head.join(", "))
}

pub fn root_of(config_path: &Path) -> PathBuf {
    config_path
        .canonicalize()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}
