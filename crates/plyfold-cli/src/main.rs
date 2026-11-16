//! plyfold: 画面なしの開発用 CLI（エンジンを端から端まで試す）

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
#[command(name = "plyfold", about = "Plyfold の開発用 CLI")]
struct Cli {
    /// 状態ディレクトリ（既定: ~/Library/Application Support/plyfold）
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    /// ターンの途中でこの秒数なにも届かなければ「無応答」にする
    #[arg(long, global = true, default_value_t = 120)]
    stall_secs: u64,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// エージェントとプロファイルの一覧（設定: <state_dir>/config.toml）
    Profiles,
    /// セッションの一覧
    Sessions,
    /// セッションを始めて対話する
    Start {
        /// プロファイル名かエージェント名
        profile: String,
        /// 作業するリポジトリ
        #[arg(long, default_value = ".")]
        repo: PathBuf,
        /// worktree を切らずに、repo で直接作業する
        #[arg(long)]
        no_worktree: bool,
        #[arg(long)]
        title: Option<String>,
        /// 最初に送るプロンプト
        #[arg(long)]
        prompt: Option<String>,
    },
    /// 止めたセッションを開き直して対話する
    Resume { session: String },
    /// 記録から会話を組み立て直して表示する
    Log { session: String },
    /// worktree の差分
    Diff { session: String },
    /// セッションを消す
    Rm {
        session: String,
        /// worktree と枝も消す（作業内容は失われる）
        #[arg(long)]
        worktree: bool,
    },
    /// API キーをキーチェーンに登録する（値は対話入力。アカウントは <名前>/<変数名>）
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
    // 組み込みの mock は、この CLI と同じ場所にある模擬エージェントを使う（開発用）
    if let Some(mock) = config.agents.get_mut("mock")
        && mock.command == "plyfold-mock-agent"
        && let Some(sibling) = std::env::current_exe()?.parent().map(|d| d.join("plyfold-mock-agent"))
        && sibling.exists()
    {
        mock.command = sibling.display().to_string();
    }
    if let Cmd::Profiles = cli.cmd {
        println!("エージェント:");
        for (id, a) in &config.agents {
            println!("  {id:10} {} {}", a.command, a.args.join(" "));
        }
        println!("プロファイル（{}）:", state_dir.join("config.toml").display());
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
            let repo = repo.canonicalize().with_context(|| format!("{} がありません", repo.display()))?;
            let mut rx = engine.subscribe();
            let title = title.unwrap_or_else(|| prompt.clone().unwrap_or_else(|| "（無題）".into()).chars().take(40).collect());
            let s = match engine.start_session(StartSession { profile, title, repo, worktree: !no_worktree }).await {
                Ok(s) => s,
                Err(e) => {
                    drain_notices(&mut rx);
                    bail!("{e}");
                }
            };
            println!("セッション {}（{}）", s.id, s.worktree_path.as_deref().or(s.repo_path.as_deref()).unwrap_or(""));
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
                println!("{:>5} {:>5}  {}{}", format!("+{}", f.added), format!("-{}", f.removed), f.path, if f.untracked { "（新規）" } else { "" });
            }
            println!("\n{}", d.patch);
        }
        Cmd::Rm { session, worktree } => {
            engine.delete_session(&session, worktree).await?;
            println!("消しました");
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
                bail!("アカウントは <名前>/<変数名> の形で指定してください（例: work/ANTHROPIC_API_KEY）");
            }
            eprintln!("{account} の値を入力してください（確認のため 2 回）");
            // 値はコマンドライン引数に載せない。security が画面に出さずに読む
            let ok = Command::new("security")
                .args(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
                .status()?
                .success();
            if !ok {
                bail!("登録に失敗しました");
            }
        }
        KeysCmd::Delete { account } => {
            let ok = Command::new("security")
                .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
                .stdout(std::process::Stdio::null())
                .status()?
                .success();
            if !ok {
                bail!("削除に失敗しました");
            }
        }
    }
    Ok(())
}

fn drain_notices(rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>) {
    while let Ok(e) = rx.try_recv() {
        if let EngineEvent::Notice { message, .. } = e {
            eprintln!("※ {message}");
        }
    }
}

struct PendingPermission {
    id: String,
    options: Vec<PermissionChoice>,
}

async fn repl(
    engine: &Engine,
    sid: &str,
    mut rx: tokio::sync::broadcast::Receiver<EngineEvent>,
    first: Option<String>,
) -> Result<()> {
    println!("入力するとプロンプトとして送ります。/model /effort /mode [値]（/mode だけなら次のモードへ） /config /cancel /diff /quit");
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
            // 溜まっているイベントを先に処理する（ターンの終わりを見落として入力を弾かないように）
            biased;
            e = rx.recv() => {
                let Ok(e) = e else { continue };
                if !belongs(&e, sid) { continue; }
                match e {
                    // ターン中に送り返される自分の発言は、すでに画面にあるので出さない
                    EngineEvent::Update { update, .. } if working && update["sessionUpdate"] == "user_message_chunk" => {}
                    EngineEvent::Update { update, .. } => render_update(&update),
                    EngineEvent::PermissionRequested { permission_id, title, options, .. } => {
                        println!("\n[権限確認] {title}");
                        for (i, o) in options.iter().enumerate() {
                            println!("  {}) {}（{}）", i + 1, o.name, o.kind);
                        }
                        println!("  c) キャンセル");
                        print!("番号: ");
                        let _ = std::io::stdout().flush();
                        pending = Some(PendingPermission { id: permission_id, options });
                    }
                    EngineEvent::TurnEnded { stop_reason, error, .. } => {
                        working = false;
                        match error {
                            Some(e) => println!("\n[ターン終了: エラー] {e}"),
                            None => println!("\n[ターン終了: {}]", stop_reason.unwrap_or_default()),
                        }
                        // ターン終了の直前に Info が届いているはずだが、念のため取り直す
                        if let Some(i) = engine.session_info(sid) {
                            info = i;
                        }
                        print!("{}", status_line(&info));
                        prompt_mark(working);
                    }
                    EngineEvent::Notice { message, .. } => println!("\n※ {message}"),
                    EngineEvent::Info { info: i, .. } => info = *i,
                    EngineEvent::Status { status, .. } => {
                        if matches!(status, Status::Error | Status::Closed) {
                            println!("\n[状態] {status:?}。終了します（plyfold resume {sid} で再開）");
                            return Ok(());
                        }
                        if status == Status::Stalled {
                            println!("\n[状態] 無応答（/cancel で中断できます）");
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
                        println!("止めました（記録と worktree は残っています。plyfold resume {sid}）");
                        return Ok(());
                    }
                    "/cancel" => engine.cancel(sid).await?,
                    "/diff" => match engine.diff(sid) {
                        Ok(d) if d.files.is_empty() => println!("変更なし"),
                        Ok(d) => {
                            for f in &d.files {
                                println!("  +{} -{}  {}{}", f.added, f.removed, f.path, if f.untracked { "（新規）" } else { "" });
                            }
                        }
                        Err(e) => println!("差分を出せません: {e}"),
                    },
                    "/config" => {
                        for o in &info.config {
                            let choices: Vec<&str> = o.choices.iter().map(|c| c.value.as_str()).collect();
                            println!("  {:20} = {:12} [{}]", o.id, o.current.as_deref().unwrap_or("-"), choices.join(", "));
                        }
                        if info.config.is_empty() && !info.modes.is_empty() {
                            println!("  mode = {}（旧来の modes）", info.current_mode.as_deref().unwrap_or("-"));
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
                                println!("  このエージェントには {cmd} の設定がありません");
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
                                Err(e) => println!("  変更できません: {e}"),
                            }
                        }
                    }
                    text => {
                        if working {
                            println!("ターンの途中です（/cancel で中断）");
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
        | EngineEvent::Info { session_id, .. } => session_id,
    };
    id == sid
}

fn render_update(u: &Value) {
    let text = || u["content"]["text"].as_str().unwrap_or("");
    match u["sessionUpdate"].as_str().unwrap_or("") {
        "agent_message_chunk" => print!("{}", text()),
        "agent_thought_chunk" => print!("\x1b[2m{}\x1b[0m", text()),
        "user_message_chunk" => print!("\n\x1b[36m> {}\x1b[0m\n", text()),
        "tool_call" => println!("\n[ツール] {}（{}）", u["title"].as_str().unwrap_or(""), u["kind"].as_str().unwrap_or("?")),
        "tool_call_update" => {
            if let Some(st @ ("completed" | "failed")) = u["status"].as_str() {
                println!("[ツール {st}] {}", u["title"].as_str().unwrap_or(u["toolCallId"].as_str().unwrap_or("")));
            }
        }
        "plan" => {
            println!("\n[計画]");
            for e in u["entries"].as_array().into_iter().flatten() {
                println!("  - [{}] {}", e["status"].as_str().unwrap_or("?"), e["content"].as_str().unwrap_or(""));
            }
        }
        _ => {}
    }
    let _ = std::io::stdout().flush();
}

/// 記録（受信した session/update）から会話を組み立て直す
fn print_log(engine: &Engine, sid: &str) -> Result<()> {
    let s = engine.store().get_session(sid)?;
    println!("{}  {}  {:?}  {}", s.id, s.profile, s.status, s.title);
    let mut after = None;
    // プロンプトを送ってから応答が返るまでの間に届く user_message_chunk は、送ったものの再掲なので出さない
    let mut in_prompt = false;
    loop {
        let events = engine.store().events(sid, after, 1000)?;
        let Some(last) = events.last() else { break };
        after = Some(last.id);
        for e in events {
            match e.kind {
                EventKind::FrameIn => {
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
                EventKind::FrameOut => {
                    let Ok(v) = serde_json::from_str::<Value>(&e.payload) else { continue };
                    if v["method"] == "session/prompt" {
                        in_prompt = true;
                        let text: String = v["params"]["prompt"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|b| b["text"].as_str())
                            .collect();
                        print!("\n\x1b[36m> {text}\x1b[0m\n");
                    }
                }
                EventKind::Note => println!("\n※ {}", e.payload),
                EventKind::Status => {}
            }
        }
    }
    println!();
    Ok(())
}

/// Claude Code の Shift+Tab のように、次のモードへ
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

/// OpenCode の入力欄のような状態行
fn status_line(info: &SessionInfo) -> String {
    let get = |c: Category| info.option(c).and_then(|o| o.current.clone());
    let mut parts = Vec::new();
    let model = get(Category::Model);
    match (&model, &info.reported_model) {
        (Some(m), Some(r)) if !r.contains(m.as_str()) => parts.push(format!("{m}（実際: {r}）")),
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
        parts.push(format!("ctx {}/{}（{:.0}%）", human(u), human(sz), u as f64 * 100.0 / sz.max(1) as f64));
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
    if parts.is_empty() {
        String::new()
    } else {
        format!("\n\x1b[2m[{}]\x1b[0m", parts.join(" · "))
    }
}
