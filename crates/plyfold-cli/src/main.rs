//! plyfold: headless developer CLI (exercises the engine end to end)

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use plyfold_core::{Category, Engine, EngineEvent, EngineOptions, PermissionChoice, SessionInfo, StartSession, Status};
use plyfold_profile::{Config, KeychainStore, default_state_dir};
use plyfold_store::EventKind;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Parser)]
#[command(name = "plyfold", about = "Plyfold developer CLI")]
struct Cli {
    /// State directory (default: ~/Library/Application Support/plyfold)
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    /// Mark a turn as stalled if nothing arrives for this many seconds
    #[arg(long, global = true, default_value_t = 120)]
    stall_secs: u64,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List agents and profiles (config: <state_dir>/config.toml)
    Profiles,
    /// List sessions
    Sessions,
    /// Start a session and chat with it
    Start {
        /// Profile name or agent name
        profile: String,
        /// Repository to work in
        #[arg(long, default_value = ".")]
        repo: PathBuf,
        /// Work directly in the repo instead of creating a worktree
        #[arg(long)]
        no_worktree: bool,
        #[arg(long)]
        title: Option<String>,
        /// First prompt to send
        #[arg(long)]
        prompt: Option<String>,
    },
    /// Reopen a stopped session and chat with it
    Resume { session: String },
    /// Rebuild the conversation from the event log and print it
    Log { session: String },
    /// Show the worktree diff
    Diff { session: String },
    /// Delete a session
    Rm {
        session: String,
        /// Also delete the worktree and branch (uncommitted work is lost)
        #[arg(long)]
        worktree: bool,
    },
    /// Store API keys in the Keychain (value is read interactively; account is <name>/<VAR>)
    Keys {
        #[command(subcommand)]
        cmd: KeysCmd,
    },
}

#[derive(Subcommand)]
enum KeysCmd {
    Set { account: String },
    Delete { account: String },
}

const KEYCHAIN_SERVICE: &str = "plyfold";

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let state_dir = cli.state_dir.clone().unwrap_or_else(default_state_dir);

    if let Cmd::Keys { cmd } = &cli.cmd {
        return keys(cmd);
    }

    let mut config = Config::load(&state_dir.join("config.toml"))?;
    // The built-in mock uses the mock agent next to this CLI binary (for development)
    if let Some(mock) = config.agents.get_mut("mock")
        && mock.command == "plyfold-mock-agent"
        && let Some(sibling) = std::env::current_exe()?.parent().map(|d| d.join("plyfold-mock-agent"))
        && sibling.exists()
    {
        mock.command = sibling.display().to_string();
    }
    if let Cmd::Profiles = cli.cmd {
        println!("Agents:");
        for (id, a) in &config.agents {
            println!("  {id:10} {} {}", a.command, a.args.join(" "));
        }
        println!("Profiles ({}):", state_dir.join("config.toml").display());
        for (name, p) in &config.profiles {
            let keys: Vec<_> = p.keys.iter().map(|(k, v)| format!("{k}←{v}")).collect();
            println!("  {name:20} agent={} isolate={} {}", p.agent, p.isolate, keys.join(" "));
        }
        return Ok(());
    }

    let engine = Engine::open(EngineOptions {
        state_dir: state_dir.clone(),
        config,
        secrets: Arc::new(KeychainStore::new(KEYCHAIN_SERVICE)),
        stall_after: Duration::from_secs(cli.stall_secs),
    })?;

    match cli.cmd {
        Cmd::Sessions => {
            for s in engine.store().list_sessions()? {
                println!(
                    "{}  {:20} {:10} {:?}  {}",
                    s.id,
                    s.profile,
                    format!("{:?}", s.status).to_lowercase(),
                    s.title,
                    s.worktree_path.or(s.repo_path).unwrap_or_default()
                );
            }
        }
        Cmd::Start { profile, repo, no_worktree, title, prompt } => {
            let repo = repo.canonicalize().with_context(|| format!("{} does not exist", repo.display()))?;
            let mut rx = engine.subscribe();
            let title = title.unwrap_or_else(|| prompt.clone().unwrap_or_else(|| "(untitled)".into()).chars().take(40).collect());
            let s = match engine.start_session(StartSession { profile, title, repo, worktree: !no_worktree }).await {
                Ok(s) => s,
                Err(e) => {
                    drain_notices(&mut rx);
                    bail!("{e}");
                }
            };
            println!("Session {} ({})", s.id, s.worktree_path.as_deref().or(s.repo_path.as_deref()).unwrap_or(""));
            repl(&engine, &s.id, rx, prompt).await?;
        }
        Cmd::Resume { session } => {
            let mut rx = engine.subscribe();
            if let Err(e) = engine.reopen_session(&session).await {
                drain_notices(&mut rx);
                bail!("{e}");
            }
            repl(&engine, &session, rx, None).await?;
        }
        Cmd::Log { session } => print_log(&engine, &session)?,
        Cmd::Diff { session } => {
            let d = engine.diff(&session)?;
            for f in &d.files {
                println!("{:>5} {:>5}  {}{}", format!("+{}", f.added), format!("-{}", f.removed), f.path, if f.untracked { " (new)" } else { "" });
            }
            println!("\n{}", d.patch);
        }
        Cmd::Rm { session, worktree } => {
            engine.delete_session(&session, worktree).await?;
            println!("Deleted");
        }
        Cmd::Profiles | Cmd::Keys { .. } => unreachable!(),
    }
    Ok(())
}

fn keys(cmd: &KeysCmd) -> Result<()> {
    use std::process::Command;
    match cmd {
        KeysCmd::Set { account } => {
            if !account.contains('/') {
                bail!("Account must be in the form <name>/<VAR> (e.g. work/ANTHROPIC_API_KEY)");
            }
            eprintln!("Enter the value for {account} (twice, to confirm)");
            // Never pass the value as an argument; `security` reads it without echoing
            let ok = Command::new("security").args(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]).status()?.success();
            if !ok {
                bail!("Failed to store the key");
            }
        }
        KeysCmd::Delete { account } => {
            let ok = Command::new("security")
                .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
                .stdout(std::process::Stdio::null())
                .status()?
                .success();
            if !ok {
                bail!("Failed to delete the key");
            }
        }
    }
    Ok(())
}

fn drain_notices(rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>) {
    while let Ok(e) = rx.try_recv() {
        if let EngineEvent::Notice { message, .. } = e {
            eprintln!("note: {message}");
        }
    }
}

struct PendingPermission {
    id: String,
    options: Vec<PermissionChoice>,
}

async fn repl(engine: &Engine, sid: &str, mut rx: tokio::sync::broadcast::Receiver<EngineEvent>, first: Option<String>) -> Result<()> {
    println!("Type to send a prompt. /model /effort /mode [value] (bare /mode cycles to the next mode) /config /cancel /diff /quit");
    let mut info: SessionInfo = engine.session_info(sid).unwrap_or_default();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut pending: Option<PendingPermission> = None;
    let mut working = false;
    if let Some(p) = first {
        engine.prompt(sid, &p)?;
        working = true;
    }
    print!("{}", status_line(&info));
    prompt_mark(working);
    loop {
        tokio::select! {
            // Drain pending events first (so a finished turn is not missed and input wrongly rejected)
            biased;
            e = rx.recv() => {
                let Ok(e) = e else { continue };
                if !belongs(&e, sid) { continue; }
                match e {
                    // Skip our own message echoed back mid-turn; it is already on screen
                    EngineEvent::Update { update, .. } if working && update["sessionUpdate"] == "user_message_chunk" => {}
                    EngineEvent::Update { update, .. } => render_update(&update),
                    EngineEvent::PermissionRequested { permission_id, title, options, .. } => {
                        println!("\n[permission] {title}");
                        for (i, o) in options.iter().enumerate() {
                            println!("  {}) {} ({})", i + 1, o.name, o.kind);
                        }
                        println!("  c) cancel");
                        print!("number: ");
                        let _ = std::io::stdout().flush();
                        pending = Some(PendingPermission { id: permission_id, options });
                    }
                    EngineEvent::TurnEnded { stop_reason, error, .. } => {
                        working = false;
                        match error {
                            Some(e) => println!("\n[turn ended: error] {e}"),
                            None => println!("\n[turn ended: {}]", stop_reason.unwrap_or_default()),
                        }
                        // Info should have arrived just before the turn ended, but fetch it again to be safe
                        if let Some(i) = engine.session_info(sid) {
                            info = i;
                        }
                        print!("{}", status_line(&info));
                        prompt_mark(working);
                    }
                    EngineEvent::Notice { message, .. } => println!("\nnote: {message}"),
                    EngineEvent::Info { info: i, .. } => info = *i,
                    EngineEvent::Status { status, .. } => {
                        if matches!(status, Status::Error | Status::Closed) {
                            println!("\n[status] {status:?}. Exiting (resume with: plyfold resume {sid})");
                            return Ok(());
                        }
                        if status == Status::Stalled {
                            println!("\n[status] stalled (/cancel to interrupt)");
                        }
                    }
                    _ => {}
                }
            }
            line = lines.next_line() => {
                let Some(line) = line? else {
                    engine.close_session(sid).await?;
                    return Ok(());
                };
                let line = line.trim().to_string();
                if let Some(p) = pending.take() {
                    let choice = line.parse::<usize>().ok().and_then(|n| p.options.get(n.wrapping_sub(1)));
                    engine.respond_permission(sid, &p.id, choice.map(|o| o.option_id.as_str())).await?;
                    continue;
                }
                match line.as_str() {
                    "" => {}
                    "/quit" => {
                        engine.close_session(sid).await?;
                        println!("Stopped (the log and worktree are kept; plyfold resume {sid})");
                        return Ok(());
                    }
                    "/cancel" => engine.cancel(sid).await?,
                    "/diff" => match engine.diff(sid) {
                        Ok(d) if d.files.is_empty() => println!("No changes"),
                        Ok(d) => {
                            for f in &d.files {
                                println!("  +{} -{}  {}{}", f.added, f.removed, f.path, if f.untracked { " (new)" } else { "" });
                            }
                        }
                        Err(e) => println!("Cannot compute the diff: {e}"),
                    },
                    "/config" => {
                        for o in &info.config {
                            let choices: Vec<&str> = o.choices.iter().map(|c| c.value.as_str()).collect();
                            println!("  {:20} = {:12} [{}]", o.id, o.current.as_deref().unwrap_or("-"), choices.join(", "));
                        }
                        if info.config.is_empty() && !info.modes.is_empty() {
                            println!("  mode = {} (legacy modes)", info.current_mode.as_deref().unwrap_or("-"));
                        }
                    }
                    l if l.starts_with("/model") || l.starts_with("/effort") || l.starts_with("/mode") => {
                        let (cmd, arg) = l.split_once(' ').map(|(c, a)| (c, a.trim())).unwrap_or((l, ""));
                        let cat = match cmd {
                            "/model" => Category::Model,
                            "/effort" => Category::ThoughtLevel,
                            _ => Category::Mode,
                        };
                        let value = if !arg.is_empty() {
                            Some(arg.to_string())
                        } else if cat == Category::Mode {
                            next_mode(&info)
                        } else {
                            if let Some(o) = info.option(cat) {
                                let choices: Vec<&str> = o.choices.iter().map(|c| c.value.as_str()).collect();
                                println!("  {} = {}  [{}]", o.id, o.current.as_deref().unwrap_or("-"), choices.join(", "));
                            } else {
                                println!("  This agent has no {cmd} setting");
                            }
                            None
                        };
                        if let Some(v) = value {
                            match engine.set_by_category(sid, cat, &v).await {
                                Ok(()) => {
                                    if let Some(i) = engine.session_info(sid) {
                                        info = i;
                                    }
                                    print!("{}", status_line(&info));
                                }
                                Err(e) => println!("  Cannot change it: {e}"),
                            }
                        }
                    }
                    text => {
                        if working {
                            println!("A turn is in progress (/cancel to interrupt)");
                        } else {
                            engine.prompt(sid, text)?;
                            working = true;
                        }
                    }
                }
                prompt_mark(working);
            }
        }
    }
}

fn prompt_mark(working: bool) {
    if !working {
        print!("\n> ");
        let _ = std::io::stdout().flush();
    }
}

fn belongs(e: &EngineEvent, sid: &str) -> bool {
    let id = match e {
        EngineEvent::SessionCreated { session } => &session.id,
        EngineEvent::Status { session_id, .. }
        | EngineEvent::Update { session_id, .. }
        | EngineEvent::PermissionRequested { session_id, .. }
        | EngineEvent::PermissionResolved { session_id, .. }
        | EngineEvent::TurnEnded { session_id, .. }
        | EngineEvent::Notice { session_id, .. }
        | EngineEvent::Info { session_id, .. }
        | EngineEvent::Renamed { session_id, .. } => session_id,
    };
    id == sid
}

fn render_update(u: &Value) {
    let text = || u["content"]["text"].as_str().unwrap_or("");
    match u["sessionUpdate"].as_str().unwrap_or("") {
        "agent_message_chunk" => print!("{}", text()),
        "agent_thought_chunk" => print!("\x1b[2m{}\x1b[0m", text()),
        "user_message_chunk" => print!("\n\x1b[36m> {}\x1b[0m\n", text()),
        "tool_call" => println!("\n[tool] {} ({})", u["title"].as_str().unwrap_or(""), u["kind"].as_str().unwrap_or("?")),
        "tool_call_update" => {
            if let Some(st @ ("completed" | "failed")) = u["status"].as_str() {
                println!("[tool {st}] {}", u["title"].as_str().unwrap_or(u["toolCallId"].as_str().unwrap_or("")));
            }
        }
        "plan" => {
            println!("\n[plan]");
            for e in u["entries"].as_array().into_iter().flatten() {
                println!("  - [{}] {}", e["status"].as_str().unwrap_or("?"), e["content"].as_str().unwrap_or(""));
            }
        }
        _ => {}
    }
    let _ = std::io::stdout().flush();
}

/// Rebuild the conversation from the log (received session/update frames)
fn print_log(engine: &Engine, sid: &str) -> Result<()> {
    let s = engine.store().get_session(sid)?;
    println!("{}  {}  {:?}  {}", s.id, s.profile, s.status, s.title);
    let mut after = None;
    // user_message_chunk frames between sending a prompt and its response echo what we sent, so skip them
    let mut in_prompt = false;
    loop {
        let events = engine.store().events(sid, after, 1000)?;
        let Some(last) = events.last() else { break };
        after = Some(last.id);
        for e in events {
            match e.kind {
                EventKind::FrameIn | EventKind::ForkIn => {
                    let Ok(v) = serde_json::from_str::<Value>(&e.payload) else { continue };
                    if v["method"] == "session/update" {
                        let u = &v["params"]["update"];
                        if !(in_prompt && u["sessionUpdate"] == "user_message_chunk") {
                            render_update(u);
                        }
                    } else if v["result"]["stopReason"].is_string() || (v.get("error").is_some() && in_prompt) {
                        in_prompt = false;
                    }
                }
                EventKind::FrameOut | EventKind::ForkOut => {
                    let Ok(v) = serde_json::from_str::<Value>(&e.payload) else { continue };
                    if v["method"] == "session/prompt" {
                        in_prompt = true;
                        let text: String = v["params"]["prompt"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect();
                        print!("\n\x1b[36m> {text}\x1b[0m\n");
                    }
                }
                EventKind::Note => println!("\nnote: {}", e.payload),
                EventKind::Status => {}
            }
        }
    }
    println!();
    Ok(())
}

/// Cycle to the next mode, like Shift+Tab in Claude Code
fn next_mode(info: &SessionInfo) -> Option<String> {
    let (choices, current): (Vec<String>, Option<String>) = match info.option(Category::Mode) {
        Some(o) => (o.choices.iter().map(|c| c.value.clone()).collect(), o.current.clone()),
        None => (info.modes.iter().map(|c| c.value.clone()).collect(), info.current_mode.clone()),
    };
    if choices.is_empty() {
        return None;
    }
    let pos = current.and_then(|c| choices.iter().position(|x| *x == c)).map(|p| p + 1).unwrap_or(0);
    Some(choices[pos % choices.len()].clone())
}

fn human(n: u64) -> String {
    match n {
        0..1_000 => n.to_string(),
        1_000..1_000_000 => format!("{:.1}k", n as f64 / 1e3),
        _ => format!("{:.2}M", n as f64 / 1e6),
    }
}

/// Status line in the style of OpenCode's input bar
fn status_line(info: &SessionInfo) -> String {
    let get = |c: Category| info.option(c).and_then(|o| o.current.clone());
    let mut parts = Vec::new();
    let model = get(Category::Model);
    match (&model, &info.reported_model) {
        (Some(m), Some(r)) if !r.contains(m.as_str()) => parts.push(format!("{m} (actual: {r})")),
        (Some(m), _) => parts.push(m.clone()),
        (None, Some(r)) => parts.push(r.clone()),
        _ => {}
    }
    if let Some(e) = get(Category::ThoughtLevel) {
        parts.push(format!("effort {e}"));
    }
    if let Some(m) = get(Category::Mode).or(info.current_mode.clone()) {
        parts.push(format!("mode {m}"));
    }
    if let (Some(u), Some(sz)) = (info.context_used, info.context_size) {
        parts.push(format!("ctx {}/{} ({:.0}%)", human(u), human(sz), u as f64 * 100.0 / sz.max(1) as f64));
    }
    if let Some(t) = &info.last_turn {
        if let Some(u) = &t.usage {
            parts.push(format!("↑{} ↓{}", human(u.input + u.cached_read + u.cached_write), human(u.output)));
        }
        if let Some(tps) = t.tokens_per_sec {
            parts.push(format!("{}{tps:.0} tok/s", if t.estimated { "~" } else { "" }));
        }
    }
    if let Some(c) = &info.cost {
        parts.push(format!("{} {:.4}", c.currency, c.amount));
    }
    if parts.is_empty() { String::new() } else { format!("\n\x1b[2m[{}]\x1b[0m", parts.join(" · ")) }
}
