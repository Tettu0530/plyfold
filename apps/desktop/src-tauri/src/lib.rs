//! The Plyfold desktop app: exposes the engine as Tauri commands and streams EngineEvents to the UI

mod dirs;
mod files;
mod platform;
mod registry;
mod shell;
mod shell_path;
mod tasks;
mod terminal;

pub use shell_path::adopt_login_path;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use plyfold_core::{Category, CliSession, Engine, EngineOptions, SessionInfo, StartSession};
use plyfold_profile::edit::{self, AuthKind, ProfileForm};
use plyfold_profile::{Config, KeychainStore, SecretStore, default_state_dir};
use plyfold_store::{EventRecord, SessionRecord};
use plyfold_worktree::Diff;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

/// Name of the event streamed to the UI
const ENGINE_EVENT: &str = "engine";
const KEYCHAIN_SERVICE: &str = "plyfold";

struct AppState {
    engine: Engine,
    terminals: terminal::Terminals,
    shells: shell::Shells,
    /// Where sessions (and the task queue) are kept: see data_dir
    data_dir: PathBuf,
    config: RwLock<Config>,
    config_path: PathBuf,
    secrets: Arc<KeychainStore>,
    state_dir: PathBuf,
    settings: RwLock<AppSettings>,
}

/// App settings (<state_dir>/settings.json). Profiles live in config.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct AppSettings {
    /// "auto" / "zed" / "cursor" / "code" / "finder"
    editor: String,
    /// After merging into main, stop the agent and delete the worktree and branch
    cleanup_after_merge: bool,
    /// Treat the agent as unresponsive if nothing arrives for this long during a turn
    stall_seconds: u64,
    /// Start new sessions in a worktree
    worktree_default: bool,
    /// Send key in the composer: "enter" (Enter sends, Shift+Enter inserts a newline) / "cmd_enter" (⌘Enter sends, Enter inserts a newline)
    send_key: String,
    /// UI language: "auto" (the macOS language) / "ja" / "en" / "zh"
    language: String,
    /// Sidebar density: "comfortable" (two lines per session) / "compact" (one line)
    sidebar_density: String,
    /// Notify when a turn finishes in a session you are not looking at
    notify_turn_end: bool,
    /// Notify when an agent asks for permission in a session you are not looking at
    notify_permission: bool,
    /// Changed keyboard shortcuts: action → combo ("cmd+shift+k"; "" unbinds). Defaults live in the UI (lib/keymap.ts)
    keybindings: std::collections::BTreeMap<String, String>,
    /// Size of the whole UI in percent (webview zoom)
    ui_scale: u32,
    /// "system" (follow macOS Reduce motion) / "reduce" (always reduce)
    reduce_motion: String,
    /// Show the agent's thinking expanded instead of collapsed
    thoughts_expanded: bool,
    /// Reopen the sessions that were in panes when the app quit
    restore_panes: bool,
    /// Profile for new sessions: "" uses the one used last
    default_profile: String,
    /// Name of the sidebar group for everyday conversations ("" = the default)
    chat_group_name: String,
    /// How many queued tasks may run at once
    max_parallel: u32,
    /// Send a prompt that hit a usage limit again, with the same key, when the limit lifts
    resume_after_limit: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            editor: "auto".into(),
            cleanup_after_merge: false,
            stall_seconds: 120,
            worktree_default: true,
            send_key: "enter".into(),
            language: "auto".into(),
            sidebar_density: "comfortable".into(),
            notify_turn_end: true,
            notify_permission: true,
            keybindings: Default::default(),
            ui_scale: 100,
            reduce_motion: "system".into(),
            thoughts_expanded: false,
            restore_panes: true,
            default_profile: String::new(),
            chat_group_name: String::new(),
            max_parallel: 2,
            resume_after_limit: true,
        }
    }
}

fn load_settings(path: &std::path::Path) -> AppSettings {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

#[derive(Serialize)]
struct SettingsView {
    settings: AppSettings,
    config_path: String,
    state_dir: String,
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> SettingsView {
    SettingsView {
        settings: state.settings.read().unwrap().clone(),
        config_path: state.config_path.display().to_string(),
        state_dir: state.state_dir.display().to_string(),
    }
}

/// Switch the language of engine messages (errors, notices) to match the UI language
#[derive(Serialize)]
struct AgentLaunch {
    id: String,
    /// The command line that starts the agent's ACP server
    command: String,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    license: String,
    repository: String,
    tauri: String,
    /// "macOS" / "Windows"
    os_name: String,
    /// The OS version, when it can be read
    os: Option<String>,
    arch: String,
    agents: Vec<AgentLaunch>,
}

/// For Settings → Info
#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    let (os_name, os) = platform::os_version();
    let cfg = state.config.read().unwrap();
    let agents = cfg
        .agents
        .iter()
        // The mock agent is for tests only
        .filter(|(id, _)| id.as_str() != "mock")
        .map(|(id, a)| AgentLaunch {
            id: id.clone(),
            command: std::iter::once(a.command.as_str()).chain(a.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" "),
        })
        .collect();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        license: env!("CARGO_PKG_LICENSE").into(),
        repository: env!("CARGO_PKG_REPOSITORY").into(),
        tauri: tauri::VERSION.into(),
        os_name: os_name.into(),
        os,
        arch: std::env::consts::ARCH.into(),
        agents,
    }
}

#[tauri::command]
fn set_ui_lang(lang: String) {
    plyfold_i18n::set_lang(&lang);
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> CmdResult<()> {
    if !["auto", "zed", "cursor", "code", "finder"].contains(&settings.editor.as_str()) {
        return Err(plyfold_i18n::tr!("エディタ '{}' は選べません", "Editor '{}' is not available", "无法选择编辑器 '{}'", settings.editor));
    }
    if !(30..=3600).contains(&settings.stall_seconds) {
        return Err(plyfold_i18n::tr!(
            "無応答とみなすまでの時間は 30 秒から 1 時間までです",
            "The no-response timeout must be between 30 seconds and 1 hour",
            "判定为无响应的时间须在 30 秒到 1 小时之间"
        ));
    }
    if !(80..=150).contains(&settings.ui_scale) {
        return Err(plyfold_i18n::tr!(
            "表示の大きさは 80% から 150% までです",
            "The display size must be between 80% and 150%",
            "显示大小须在 80% 到 150% 之间"
        ));
    }
    if !["system", "reduce"].contains(&settings.reduce_motion.as_str())
        || settings.default_profile.len() > 128
        || settings.chat_group_name.chars().count() > 80
        || !(1..=8).contains(&settings.max_parallel)
    {
        return Err(plyfold_i18n::tr!("設定の値が正しくありません", "A setting has an invalid value", "某项设置的值无效"));
    }
    // Shortcuts are checked fully in the UI; here only keep the file small and plain
    let plain = |s: &str, max: usize| s.len() <= max && s.chars().all(|c| c.is_ascii_graphic());
    if settings.keybindings.len() > 64 || settings.keybindings.iter().any(|(a, c)| !plain(a, 32) || !(c.is_empty() || plain(c, 48))) {
        return Err(plyfold_i18n::tr!("ショートカットの設定が正しくありません", "The keyboard shortcut settings are not valid", "快捷键设置无效"));
    }
    let path = state.state_dir.join("settings.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&settings).map_err(err)?).map_err(err)?;
    std::fs::rename(tmp, path).map_err(err)?;
    state.engine.set_stall_after(Duration::from_secs(settings.stall_seconds));
    state.engine.set_resume_after_limit(settings.resume_after_limit);
    *state.settings.write().unwrap() = settings;
    Ok(())
}

/// Reveal the config file (or the data folder if it does not exist) in Finder / File Explorer
#[tauri::command]
fn reveal_path(state: State<'_, AppState>, which: String) -> CmdResult<()> {
    match which.as_str() {
        "config" if state.config_path.exists() => platform::reveal(&state.config_path),
        _ => platform::open(&state.state_dir.display().to_string()),
    }
    .map_err(err)
}

impl AppState {
    /// Reload config.toml and apply it to both the UI and the engine
    fn reload(&self) -> CmdResult<()> {
        let mut config = Config::load(&self.config_path).map_err(err)?;
        resolve_mock_agent(&mut config);
        self.engine.set_config(config.clone());
        *self.config.write().unwrap() = config;
        Ok(())
    }
}

/// Command errors are returned as strings (shown as-is in the UI)
type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
struct ProfileSummary {
    name: String,
    agent: String,
    label: String,
    isolate: bool,
    /// Authenticates with a key (not an existing login)
    keyed: bool,
    /// Uses a key billed by use, so it can be another profile's fallback (not a sign-in or subscription token)
    uses_key: bool,
    /// Has a custom endpoint (base URL)
    custom_provider: bool,
    /// The agent's name, for agents added from the ACP Registry (built-in ones are named by the UI)
    agent_name: Option<String>,
    /// The agent's icon (SVG text), kept when it was added from the ACP Registry
    agent_icon: Option<String>,
}

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Vec<ProfileSummary> {
    let cfg = state.config.read().unwrap();
    let meta = |agent: &str| {
        let name = cfg.agents.get(agent).and_then(|a| a.name.clone());
        let icon = std::fs::read_to_string(registry::icon_path(&state.state_dir, agent)).ok();
        (name, icon)
    };
    let mut out: Vec<ProfileSummary> = cfg
        .profiles
        .iter()
        .map(|(name, p)| {
            let (agent_name, agent_icon) = meta(&p.agent);
            ProfileSummary {
                name: name.clone(),
                agent: p.agent.clone(),
                label: p.label.clone().unwrap_or_else(|| name.clone()),
                isolate: p.isolate,
                keyed: !p.keys.is_empty(),
                uses_key: p.uses_key(),
                custom_provider: p.env.keys().any(|k| k.ends_with("BASE_URL")) || p.files.contains_key("config.toml"),
                agent_name,
                agent_icon,
            }
        })
        .collect();
    // A bare agent name can also be chosen, as a default profile that uses the existing login
    for agent in cfg.agents.keys() {
        let (agent_name, agent_icon) = meta(agent);
        out.push(ProfileSummary {
            name: agent.clone(),
            agent: agent.clone(),
            label: "default".into(),
            isolate: false,
            keyed: false,
            uses_key: false,
            custom_provider: false,
            agent_name,
            agent_icon,
        });
    }
    out
}

/// The agents in the ACP Registry, and which of them are built in or already added
#[tauri::command]
async fn registry_agents(state: State<'_, AppState>) -> CmdResult<Vec<registry::Listed>> {
    let dir = state.state_dir.clone();
    let agents = state.config.read().unwrap().agents.clone();
    tauri::async_runtime::spawn_blocking(move || registry::list(&dir, &agents)).await.map_err(err)?
}

/// Add an agent from the ACP Registry (or update it to the registry's version)
#[tauri::command]
async fn add_registry_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let (dir, path) = (state.state_dir.clone(), state.config_path.clone());
    tauri::async_runtime::spawn_blocking(move || registry::add(&dir, &path, &id)).await.map_err(err)??;
    state.reload()
}

#[tauri::command]
fn remove_registry_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let (agents, used_by) = {
        let cfg = state.config.read().unwrap();
        let used_by: Vec<String> = cfg.profiles.iter().filter(|(_, p)| p.agent == id).map(|(n, _)| n.clone()).collect();
        (cfg.agents.clone(), used_by)
    };
    registry::remove(&state.state_dir, &state.config_path, &agents, &used_by, &id)?;
    state.reload()
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> CmdResult<Vec<SessionRecord>> {
    state.engine.store().list_sessions().map_err(err)
}

#[tauri::command]
async fn usage_summary(state: State<'_, AppState>, days: u32) -> CmdResult<Vec<plyfold_core::ProfileUsage>> {
    let since = plyfold_store::now_ms() - i64::from(days) * 86_400_000;
    let events = state.engine.store().usage_events(since).map_err(err)?;
    Ok(plyfold_core::usage::summarize(&events, since))
}

#[tauri::command]
fn session_history(state: State<'_, AppState>, id: String) -> CmdResult<Vec<EventRecord>> {
    let mut all = Vec::new();
    let mut after = None;
    loop {
        let page = state.engine.store().events(&id, after, 2000).map_err(err)?;
        let Some(last) = page.last() else { break };
        after = Some(last.id);
        all.extend(page);
    }
    Ok(all)
}

#[tauri::command]
async fn start_session(
    state: State<'_, AppState>,
    profile: String,
    repo: String,
    title: String,
    worktree: bool,
    created: tauri::ipc::Channel<SessionRecord>,
) -> CmdResult<SessionRecord> {
    let repo = PathBuf::from(expand_home(&repo));
    state
        .engine
        .start_session_with_created(StartSession { profile, title, repo, worktree }, |record| {
            let _ = created.send(record.clone());
        })
        .await
        .map_err(err)
}

#[tauri::command]
async fn reopen_session(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.reopen_session(&id).await.map_err(err)
}

#[tauri::command]
async fn fork_session(state: State<'_, AppState>, id: String, new_worktree: bool) -> CmdResult<SessionRecord> {
    state.engine.fork_session(&id, new_worktree).await.map_err(err)
}

#[tauri::command]
async fn start_chat(state: State<'_, AppState>, profile: String, title: String, created: tauri::ipc::Channel<SessionRecord>) -> CmdResult<SessionRecord> {
    state
        .engine
        .start_chat_with_created(&profile, &title, |record| {
            let _ = created.send(record.clone());
        })
        .await
        .map_err(err)
}

#[tauri::command]
async fn open_side_chat(state: State<'_, AppState>, id: String) -> CmdResult<SessionRecord> {
    state.engine.open_side_chat(&id).await.map_err(err)
}

/// Sessions whose prompt waits for a usage limit to lift, and when it goes out (ms)
#[tauri::command]
fn scheduled_resumes(state: State<'_, AppState>) -> Vec<(String, i64)> {
    state.engine.scheduled_resumes()
}

#[tauri::command]
async fn resume_now(state: State<'_, AppState>, id: String) -> CmdResult<bool> {
    Ok(state.engine.resume_now(&id).await)
}

#[tauri::command]
fn cancel_resume(state: State<'_, AppState>, id: String) -> bool {
    state.engine.cancel_resume(&id)
}

/// Hand the session over to another profile in the same workspace (see Engine::hand_over)
#[tauri::command]
async fn hand_over(state: State<'_, AppState>, id: String, profile: String) -> CmdResult<SessionRecord> {
    state.engine.hand_over(&id, &profile).await.map_err(err)
}

#[tauri::command]
async fn set_reviewer(state: State<'_, AppState>, id: String, profile: Option<String>) -> CmdResult<SessionRecord> {
    state.engine.set_reviewer(&id, profile.as_deref()).await.map_err(err)
}

/// Review the session's current diff now, even if it was reviewed already (None: there is no diff)
#[tauri::command]
async fn review_now(state: State<'_, AppState>, id: String) -> CmdResult<Option<String>> {
    state.engine.review(&id, None, true).await.map_err(err)
}

#[tauri::command]
async fn close_side_chat(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.close_side_chat(&id).await.map_err(err)
}

#[tauri::command]
async fn list_cli_sessions(state: State<'_, AppState>, profile: String, repo: String) -> CmdResult<Vec<CliSession>> {
    let repo = PathBuf::from(expand_home(&repo));
    state.engine.list_cli_sessions(&profile, &repo).await.map_err(err)
}

#[tauri::command]
async fn adopt_cli_session(
    state: State<'_, AppState>,
    profile: String,
    repo: String,
    acp_session_id: String,
    title: String,
    worktree: bool,
    created: tauri::ipc::Channel<SessionRecord>,
) -> CmdResult<SessionRecord> {
    let repo = PathBuf::from(expand_home(&repo));
    state
        .engine
        .adopt_session_with_created(&profile, &repo, &acp_session_id, &title, worktree, |record| {
            let _ = created.send(record.clone());
        })
        .await
        .map_err(err)
}

#[tauri::command]
async fn close_session(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.close_session(&id).await.map_err(err)
}

#[tauri::command]
async fn trash_session(state: State<'_, AppState>, id: String) -> CmdResult<SessionRecord> {
    state.engine.trash_session(&id).await.map_err(err)
}

#[tauri::command]
fn set_run_group(state: State<'_, AppState>, id: String, group: Option<String>) -> CmdResult<SessionRecord> {
    state.engine.set_run_group(&id, group.as_deref()).map_err(err)
}

#[tauri::command]
fn restore_session(state: State<'_, AppState>, id: String) -> CmdResult<SessionRecord> {
    state.engine.restore_session(&id).map_err(err)
}

#[tauri::command]
async fn empty_trash(state: State<'_, AppState>, remove_worktree: bool) -> CmdResult<Vec<String>> {
    state.engine.empty_trash(remove_worktree).await.map_err(err)
}

#[tauri::command]
async fn delete_session(state: State<'_, AppState>, id: String, remove_worktree: bool) -> CmdResult<()> {
    state.engine.delete_session(&id, remove_worktree).await.map_err(err)
}

#[tauri::command]
async fn prompt(state: State<'_, AppState>, id: String, text: String, attachments: Option<Vec<plyfold_core::Attachment>>) -> CmdResult<()> {
    state.engine.prompt_with(&id, &text, &attachments.unwrap_or_default()).map_err(err)
}

#[tauri::command]
async fn cancel(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.cancel(&id).await.map_err(err)
}

#[tauri::command]
async fn respond_permission(state: State<'_, AppState>, id: String, permission_id: String, option_id: Option<String>) -> CmdResult<()> {
    state.engine.respond_permission(&id, &permission_id, option_id.as_deref()).await.map_err(err)
}

#[tauri::command]
async fn set_by_category(state: State<'_, AppState>, id: String, category: Category, value: String) -> CmdResult<()> {
    state.engine.set_by_category(&id, category, &value).await.map_err(err)
}

#[tauri::command]
fn session_info(state: State<'_, AppState>, id: String) -> Option<SessionInfo> {
    state.engine.session_info(&id)
}

#[tauri::command]
async fn session_diff(state: State<'_, AppState>, id: String) -> CmdResult<Diff> {
    state.engine.diff(&id).map_err(err)
}

/// Completion for the repository picker (dirs.rs)
/// An image file as a data: URL, for thumbnails and previews of attached images that were added by path
/// (dropped or picked). Only common image types, up to 20 MB
#[tauri::command]
async fn read_image(path: String) -> CmdResult<String> {
    use base64::Engine as _;
    let p = std::path::PathBuf::from(expand_home(&path));
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(plyfold_i18n::tr!("画像ではありません", "Not an image", "不是图片"));
    }
    // The name alone says nothing (a link named .png may point at any file): the bytes must be an image, and the
    // type shown is theirs
    let read = tauri::async_runtime::spawn_blocking(move || plyfold_core::attach::read_image_file(&p, 20 * 1024 * 1024)).await.map_err(err)?;
    let Some((bytes, mime)) = read.map_err(err)? else {
        return Err(plyfold_i18n::tr!(
            "画像として読めません（画像でないか、20 MB を超えています）",
            "Cannot be read as an image (not an image, or over 20 MB)",
            "无法作为图片读取（不是图片，或超过 20 MB）"
        ));
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A text file's contents for the touched-files pane: the first MiB, or nothing for a binary file
#[derive(serde::Serialize)]
struct TextFile {
    /// None for a binary file (a NUL byte, or not UTF-8)
    text: Option<String>,
    size: u64,
    /// Only the first MiB was read
    truncated: bool,
}

#[tauri::command]
async fn read_text_file(path: String) -> CmdResult<TextFile> {
    use std::io::Read as _;
    const LIMIT: u64 = 1024 * 1024;
    let p = std::path::PathBuf::from(expand_home(&path));
    let size = std::fs::metadata(&p).map_err(err)?.len();
    let mut bytes = Vec::new();
    std::fs::File::open(&p).map_err(err)?.take(LIMIT).read_to_end(&mut bytes).map_err(err)?;
    let truncated = size > LIMIT;
    // A cut may split a multi-byte character at the end
    let text = if bytes.contains(&0) {
        None
    } else {
        match String::from_utf8(bytes) {
            Ok(t) => Some(t),
            Err(e) if truncated && e.utf8_error().error_len().is_none() => {
                let valid = e.utf8_error().valid_up_to();
                let mut b = e.into_bytes();
                b.truncate(valid);
                String::from_utf8(b).ok()
            }
            Err(_) => None,
        }
    };
    Ok(TextFile { text, size, truncated })
}

/// A repository Plyfold knows, with its settings (Settings → Repositories)
#[derive(serde::Serialize)]
struct RepoEntry {
    path: String,
    settings: plyfold_core::repos::RepoSettings,
}

#[tauri::command]
fn list_repos(state: State<'_, AppState>) -> CmdResult<Vec<RepoEntry>> {
    let repos = state.engine.known_repos().map_err(err)?;
    Ok(repos.into_iter().map(|path| RepoEntry { settings: state.engine.repo_settings(&path), path }).collect())
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> Vec<tasks::Task> {
    tasks::load(&state.data_dir)
}

#[tauri::command]
fn save_tasks(state: State<'_, AppState>, tasks: Vec<tasks::Task>) -> CmdResult<()> {
    tasks::save(&state.data_dir, &tasks)
}

/// Rename a repository's group in the sidebar ("" goes back to the folder's name)
#[tauri::command]
fn rename_repo(state: State<'_, AppState>, path: String, name: String) -> CmdResult<()> {
    let name = name.trim();
    if name.chars().count() > 80 {
        return Err(plyfold_i18n::tr!("名前が長すぎます（80 文字まで）", "The name is too long (80 characters max)", "名称太长（最多 80 个字符）"));
    }
    let mut settings = state.engine.repo_settings(&path);
    settings.name = name.to_string();
    state.engine.set_repo_settings(&path, settings).map_err(err)
}

#[tauri::command]
fn save_repo_settings(state: State<'_, AppState>, path: String, settings: plyfold_core::repos::RepoSettings) -> CmdResult<()> {
    state.engine.set_repo_settings(&path, settings).map_err(err)
}

/// Open one file in the editor chosen in Settings (or the system's app for it)
#[tauri::command]
fn open_file_in_editor(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    let editor = state.settings.read().unwrap().editor.clone();
    let p = std::path::PathBuf::from(expand_home(&path));
    if !p.exists() {
        return Err(plyfold_i18n::tr!("ファイルが見つかりません", "File not found", "找不到文件"));
    }
    plyfold_worktree::ops::open_path_in_editor(&p, &editor).map_err(err)
}

/// Files for @-mentions in the composer (files.rs). `root` is the session's worktree or repository
#[tauri::command]
async fn search_files(root: Option<String>, query: String, exact: bool) -> Vec<files::FileHit> {
    static INDEX: std::sync::LazyLock<files::FileIndex> = std::sync::LazyLock::new(files::FileIndex::default);
    tauri::async_runtime::spawn_blocking(move || {
        let root = root.as_deref().map(expand_home).map(PathBuf::from);
        let path = PathBuf::from(expand_home(&query));
        let complete = exact || query.contains('/') || cfg!(windows) && query.contains('\\');
        if !query.is_empty() {
            let hits = files::path_candidates(root.as_deref(), &path, &query, complete, 50);
            if exact || !hits.is_empty() {
                return hits;
            }
        }
        match root {
            Some(root) if root.is_dir() => INDEX.search(&root, &query, 50),
            _ => Vec::new(),
        }
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn complete_dirs(input: String) -> Vec<dirs::DirCandidate> {
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default());
    dirs::complete(&input, &home)
}

fn expand_home(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_or_else(|_| p.to_owned(), |home| format!("{home}/{rest}")),
        None => p.to_string(),
    }
}

/// During development, use the mock agent in the workspace's target directory. A release build never swaps in a
/// program found next to it or named by an environment variable
fn resolve_mock_agent(config: &mut Config) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(mock) = config.agents.get_mut("mock") else { return };
    if mock.command != "plyfold-mock-agent" {
        return;
    }
    let candidates = [
        std::env::var("PLYFOLD_MOCK_AGENT").ok().map(PathBuf::from),
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("plyfold-mock-agent"))),
    ];
    if let Some(found) = candidates.into_iter().flatten().find(|p| p.exists()) {
        mock.command = found.display().to_string();
    }
}

#[derive(Serialize)]
struct ProfileDetail {
    form: ProfileForm,
    supported: Vec<AuthKind>,
    /// Environment variable that carries the key
    key_var: Option<String>,
    /// Keychain account name
    key_account: Option<String>,
    key_set: bool,
    /// Last 4 characters of the saved key (to tell keys apart; the full key never reaches the UI)
    key_tail: Option<String>,
    /// Other profiles that use the same key
    shared_with: Vec<String>,
    /// Environment variable overridden to give the profile its own config directory
    config_dir_env: Option<String>,
}

#[tauri::command]
fn profile_detail(state: State<'_, AppState>, name: String) -> CmdResult<ProfileDetail> {
    let cfg = state.config.read().unwrap();
    let def =
        cfg.profiles.get(&name).ok_or_else(|| plyfold_i18n::tr!("プロファイル '{name}' はありません", "Profile '{name}' not found", "配置 '{name}' 不存在"))?;
    let form = edit::describe(&name, def);
    let account = edit::key_account(&name, def);
    let value = account.as_ref().and_then(|(_, a)| state.secrets.get(a).ok());
    let shared_with = match &account {
        Some((_, a)) => {
            cfg.profiles.iter().filter(|(n, d)| **n != name && edit::key_account(n, d).is_some_and(|(_, b)| &b == a)).map(|(n, _)| n.clone()).collect()
        }
        None => Vec::new(),
    };
    Ok(ProfileDetail {
        supported: edit::supported_auth(&def.agent),
        key_var: account.as_ref().map(|(v, _)| v.clone()),
        key_account: account.as_ref().map(|(_, a)| a.clone()),
        key_set: value.is_some(),
        key_tail: value.map(|v| v.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()),
        shared_with,
        config_dir_env: cfg.agents.get(&def.agent).and_then(|a| a.config_dir_env.clone()),
        form,
    })
}

/// Save. If the name differs from `original`, rename the profile (and move its keychain entry)
#[tauri::command]
fn save_profile(state: State<'_, AppState>, form: ProfileForm, original: Option<String>) -> CmdResult<()> {
    let (def, old_account) = {
        let cfg = state.config.read().unwrap();
        let renaming = original.as_deref().is_some_and(|o| o != form.name);
        if original.is_none() || renaming {
            edit::validate_name(&form.name, &cfg).map_err(err)?;
            if cfg.profiles.contains_key(&form.name) {
                return Err(plyfold_i18n::tr!(
                    "'{}' という名前のプロファイルはもうあります",
                    "A profile named '{}' already exists",
                    "名为 '{}' 的配置已存在",
                    form.name
                ));
            }
        }
        if !cfg.agents.contains_key(&form.agent) {
            return Err(plyfold_i18n::tr!("エージェント '{}' はありません", "Agent '{}' not found", "代理 '{}' 不存在", form.agent));
        }
        let existing = original.as_ref().and_then(|o| cfg.profiles.get(o));
        let def = edit::to_def(&form, existing).map_err(err)?;
        // A fallback is another profile of the same agent with a key billed by use; moving between subscriptions when
        // one hits its limit is the kind of use providers' terms forbid
        if let Some(to) = &def.fallback
            && !cfg.profiles.get(to).is_some_and(|p| p.agent == def.agent && p.uses_key())
        {
            return Err(plyfold_i18n::tr!(
                "切り替え先には、同じエージェントで API キーかカスタムプロバイダーを使うプロファイルだけを選べます（CLI のログインのまま使うプロファイルは選べません）",
                "The fallback must be a profile of the same agent that uses an API key or a custom provider (not one that uses the CLI's own sign-in)",
                "切换目标只能是同一代理中使用 API 密钥或自定义提供商的配置（不能选择沿用 CLI 登录的配置）"
            ));
        }
        let old_account = original.as_ref().zip(existing).and_then(|(o, d)| edit::key_account(o, d));
        (def, old_account)
    };
    // On rename, move this profile's own key to the account under the new name
    if let (Some(orig), Some((_, old))) = (original.as_ref(), old_account.as_ref())
        && orig != &form.name
        && let Some((_, new)) = edit::key_account(&form.name, &def)
        && new != *old
        && let Ok(v) = state.secrets.get(old)
    {
        state.secrets.set(&new, &v).map_err(err)?;
        let _ = state.secrets.delete(old);
    }
    edit::upsert_profile(&state.config_path, &form.name, &def).map_err(err)?;
    if let Some(orig) = original.filter(|o| *o != form.name) {
        edit::remove_profile(&state.config_path, &orig).map_err(err)?;
    }
    state.reload()
}

/// MCP servers passed to every profile, as forms for the settings screen
#[tauri::command]
fn shared_mcp(state: State<'_, AppState>) -> Vec<edit::McpForm> {
    state.config.read().unwrap().mcp.iter().map(edit::McpForm::from).collect()
}

#[tauri::command]
fn save_shared_mcp(state: State<'_, AppState>, servers: Vec<edit::McpForm>) -> CmdResult<()> {
    let servers = edit::mcp_servers(&servers).map_err(err)?;
    edit::set_shared_mcp(&state.config_path, &servers).map_err(err)?;
    state.reload()
}

/// Save a key to the keychain (the value is never logged or returned to the UI)
#[tauri::command]
fn set_profile_key(state: State<'_, AppState>, name: String, value: String) -> CmdResult<()> {
    let value = value.trim();
    if value.is_empty() {
        return Err(plyfold_i18n::tr!("キーが空です", "The key is empty", "密钥为空"));
    }
    let cfg = state.config.read().unwrap();
    let def =
        cfg.profiles.get(&name).ok_or_else(|| plyfold_i18n::tr!("プロファイル '{name}' はありません", "Profile '{name}' not found", "配置 '{name}' 不存在"))?;
    let (_, account) = edit::key_account(&name, def)
        .ok_or_else(|| plyfold_i18n::tr!("このプロファイルはキーを使いません", "This profile does not use a key", "此配置不使用密钥"))?;
    state.secrets.set(&account, value).map_err(err)
}

/// Delete. Also removes this profile's own key from the keychain (shared keys are kept)
#[tauri::command]
fn delete_profile(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    let own = {
        let cfg = state.config.read().unwrap();
        let def = cfg
            .profiles
            .get(&name)
            .ok_or_else(|| plyfold_i18n::tr!("プロファイル '{name}' はありません", "Profile '{name}' not found", "配置 '{name}' 不存在"))?;
        edit::key_account(&name, def).filter(|(var, a)| *a == format!("{name}/{var}"))
    };
    edit::remove_profile(&state.config_path, &name).map_err(err)?;
    if let Some((_, a)) = own {
        let _ = state.secrets.delete(&a);
    }
    state.reload()
}

#[tauri::command]
async fn worktree_status(state: State<'_, AppState>, id: String) -> CmdResult<plyfold_worktree::WtStatus> {
    state.engine.worktree_status(&id).map_err(err)
}

#[tauri::command]
async fn commit_session(state: State<'_, AppState>, id: String, message: String) -> CmdResult<String> {
    state.engine.commit(&id, &message).map_err(err)
}

#[derive(Serialize)]
struct MergeResult {
    target: String,
    /// The worktree was cleaned up according to the settings
    cleaned: bool,
}

#[tauri::command]
async fn merge_session(state: State<'_, AppState>, id: String) -> CmdResult<MergeResult> {
    let target = state.engine.merge(&id).map_err(err)?;
    let cleanup = state.settings.read().unwrap().cleanup_after_merge;
    let cleaned = if cleanup {
        state.engine.cleanup_worktree(&id).await.map_err(|e| {
            plyfold_i18n::tr!(
                "{target} には取り込みましたが、片付けに失敗しました: {e}",
                "Merged into {target}, but cleanup failed: {e}",
                "已合并到 {target}，但清理失败：{e}"
            )
        })?
    } else {
        false
    };
    Ok(MergeResult { target, cleaned })
}

/// Git commands run git (and the network for fetch / push / pull / gh) synchronously, so keep them off the async workers
async fn blocking<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&plyfold_core::Engine) -> Result<T, plyfold_core::CoreError> + Send + 'static,
) -> CmdResult<T> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || f(&engine)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn git_info(state: State<'_, AppState>, id: String) -> CmdResult<plyfold_worktree::remote::GitInfo> {
    blocking(&state, move |e| e.git_info(&id)).await
}

#[tauri::command]
async fn git_history(state: State<'_, AppState>, id: String) -> CmdResult<plyfold_worktree::history::History> {
    blocking(&state, move |e| e.git_history(&id)).await
}

#[tauri::command]
async fn git_checkout(state: State<'_, AppState>, id: String, target: plyfold_worktree::history::Checkout) -> CmdResult<()> {
    blocking(&state, move |e| e.git_checkout(&id, target)).await
}

#[tauri::command]
async fn git_fetch(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    blocking(&state, move |e| e.git_fetch(&id)).await
}

#[tauri::command]
async fn git_push(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    blocking(&state, move |e| e.git_push(&id)).await
}

#[tauri::command]
async fn git_pull(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    blocking(&state, move |e| e.git_pull(&id)).await
}

#[tauri::command]
async fn pull_request(state: State<'_, AppState>, id: String) -> CmdResult<Option<plyfold_worktree::remote::PullRequest>> {
    blocking(&state, move |e| e.pull_request(&id)).await
}

#[tauri::command]
async fn create_pr(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    state.engine.create_pr(&id).map_err(err)
}

/// Open a link from the conversation in the default browser (opening it in the WebView would navigate the app away).
/// Only http / https / mailto are allowed
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    let ok = ["http://", "https://", "mailto:"].iter().any(|p| url.starts_with(p));
    if !ok || url.chars().any(char::is_control) {
        return Err(plyfold_i18n::tr!("このリンクは開けません", "This link cannot be opened", "无法打开此链接"));
    }
    platform::open(&url).map_err(err)?;
    Ok(())
}

/// Reveal a file the agent touched in Finder (only if it exists)
#[tauri::command]
fn reveal_file(path: String) -> CmdResult<()> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.exists() {
        return Err(plyfold_i18n::tr!("ファイルが見つかりません", "File not found", "找不到文件"));
    }
    platform::reveal(p).map_err(err)
}

#[tauri::command]
fn open_in_editor(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let editor = state.settings.read().unwrap().editor.clone();
    state.engine.open_in_editor(&id, &editor).map_err(err)
}

#[tauri::command]
async fn discard_session_changes(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.discard(&id).map_err(err)
}

/// Rename a session
#[tauri::command]
fn rename_session(state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(plyfold_i18n::tr!("名前が空です", "The name is empty", "名称为空"));
    }
    state.engine.store().rename_by_user(&id, title).map_err(err)
}

#[tauri::command]
async fn check_profile(state: State<'_, AppState>, name: String) -> CmdResult<plyfold_core::check::CheckResult> {
    Ok(state.engine.check_profile(&name).await)
}

/// Where sessions are kept. A development build (npm run tauri dev) uses its own folder inside the state directory,
/// so running it beside the installed app never mixes their sessions; profiles and settings stay shared.
/// PLYFOLD_DATA_DIR overrides both
fn data_dir(state_dir: &std::path::Path) -> PathBuf {
    if let Some(d) = std::env::var_os("PLYFOLD_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    if cfg!(debug_assertions) { state_dir.join("dev") } else { state_dir.to_path_buf() }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let state_dir = default_state_dir();
            let config_path = state_dir.join("config.toml");
            let mut config = Config::load(&config_path)?;
            resolve_mock_agent(&mut config);
            let secrets = Arc::new(KeychainStore::new(KEYCHAIN_SERVICE));
            let settings = load_settings(&state_dir.join("settings.json"));
            let engine = Engine::open(EngineOptions {
                state_dir: state_dir.clone(),
                data_dir: Some(data_dir(&state_dir)),
                config: config.clone(),
                secrets: secrets.clone(),
                stall_after: Duration::from_secs(settings.stall_seconds),
            })?;
            engine.set_resume_after_limit(settings.resume_after_limit);

            // Forward engine events to the UI as-is
            let mut rx = engine.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(event) => {
                            let _ = handle.emit(ENGINE_EVENT, &event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });

            app.manage(AppState {
                engine,
                terminals: terminal::Terminals::default(),
                shells: shell::Shells::default(),
                data_dir: data_dir(&state_dir),
                config: RwLock::new(config),
                config_path,
                secrets,
                state_dir,
                settings: RwLock::new(settings),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::start_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::stop_terminal,
            shell::start_shell,
            shell::stop_shell,
            list_profiles,
            list_sessions,
            session_history,
            usage_summary,
            complete_dirs,
            search_files,
            read_image,
            read_text_file,
            trash_session,
            restore_session,
            set_run_group,
            empty_trash,
            list_repos,
            list_tasks,
            scheduled_resumes,
            resume_now,
            cancel_resume,
            set_reviewer,
            review_now,
            hand_over,
            shared_mcp,
            save_shared_mcp,
            save_tasks,
            rename_repo,
            save_repo_settings,
            open_file_in_editor,
            open_url,
            reveal_file,
            start_session,
            reopen_session,
            fork_session,
            start_chat,
            open_side_chat,
            close_side_chat,
            list_cli_sessions,
            registry_agents,
            add_registry_agent,
            remove_registry_agent,
            adopt_cli_session,
            close_session,
            delete_session,
            prompt,
            cancel,
            respond_permission,
            set_by_category,
            session_info,
            session_diff,
            profile_detail,
            save_profile,
            set_profile_key,
            delete_profile,
            check_profile,
            rename_session,
            worktree_status,
            commit_session,
            merge_session,
            discard_session_changes,
            create_pr,
            git_info,
            git_history,
            git_checkout,
            git_fetch,
            git_push,
            git_pull,
            pull_request,
            open_in_editor,
            get_settings,
            save_settings,
            app_info,
            reveal_path,
            set_ui_lang,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Plyfold");
}
