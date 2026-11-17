//! Plyfold のデスクトップアプリ: エンジンを Tauri のコマンドとして公開し、EngineEvent を画面へ流す

mod dirs;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use plyfold_core::{Category, Engine, EngineOptions, SessionInfo, StartSession};
use plyfold_profile::edit::{self, AuthKind, ProfileForm};
use plyfold_profile::{Config, KeychainStore, SecretStore, default_state_dir};
use plyfold_store::{EventRecord, SessionRecord};
use plyfold_worktree::Diff;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

/// 画面へ流すイベントの名前
const ENGINE_EVENT: &str = "engine";
const KEYCHAIN_SERVICE: &str = "plyfold";

struct AppState {
    engine: Engine,
    config: RwLock<Config>,
    config_path: PathBuf,
    secrets: Arc<KeychainStore>,
    state_dir: PathBuf,
    settings: RwLock<AppSettings>,
}

/// アプリの設定（<state_dir>/settings.json）。プロファイルは config.toml の方
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct AppSettings {
    /// "auto" / "zed" / "cursor" / "code" / "finder"
    editor: String,
    /// main に取り込んだら、エージェントを止めて worktree と枝を消す
    cleanup_after_merge: bool,
    /// ターンの途中でこれだけ何も届かなければ無応答にする
    stall_seconds: u64,
    /// 新しいセッションを worktree で始める
    worktree_default: bool,
    /// 入力欄で送るキー: "enter"（Enter で送り Shift+Enter で改行）/ "cmd_enter"（⌘Enter で送り Enter で改行）
    send_key: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { editor: "auto".into(), cleanup_after_merge: false, stall_seconds: 120, worktree_default: true, send_key: "enter".into() }
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

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> CmdResult<()> {
    if !["auto", "zed", "cursor", "code", "finder"].contains(&settings.editor.as_str()) {
        return Err(format!("エディタ '{}' は選べません", settings.editor));
    }
    if !(30..=3600).contains(&settings.stall_seconds) {
        return Err("無応答とみなすまでの時間は 30 秒から 1 時間までです".into());
    }
    let path = state.state_dir.join("settings.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&settings).map_err(err)?).map_err(err)?;
    std::fs::rename(tmp, path).map_err(err)?;
    state.engine.set_stall_after(Duration::from_secs(settings.stall_seconds));
    *state.settings.write().unwrap() = settings;
    Ok(())
}

/// 設定ファイル（なければデータのフォルダ）を Finder で見せる
#[tauri::command]
fn reveal_path(state: State<'_, AppState>, which: String) -> CmdResult<()> {
    let mut cmd = std::process::Command::new("open");
    match which.as_str() {
        "config" if state.config_path.exists() => cmd.arg("-R").arg(&state.config_path),
        _ => cmd.arg(&state.state_dir),
    };
    cmd.spawn().map_err(err)?;
    Ok(())
}

impl AppState {
    /// config.toml を読み直し、画面とエンジンの両方に反映する
    fn reload(&self) -> CmdResult<()> {
        let mut config = Config::load(&self.config_path).map_err(err)?;
        resolve_mock_agent(&mut config);
        self.engine.set_config(config.clone());
        *self.config.write().unwrap() = config;
        Ok(())
    }
}

/// コマンドのエラーは文字列で返す（画面でそのまま見せる）
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
    /// キーで認証する（既存のログインではない）
    keyed: bool,
    /// 独自の接続先（ベース URL）を持つ
    custom_provider: bool,
}

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Vec<ProfileSummary> {
    let cfg = state.config.read().unwrap();
    let mut out: Vec<ProfileSummary> = cfg
        .profiles
        .iter()
        .map(|(name, p)| ProfileSummary {
            name: name.clone(),
            agent: p.agent.clone(),
            label: p.label.clone().unwrap_or_else(|| name.clone()),
            isolate: p.isolate,
            keyed: !p.keys.is_empty(),
            custom_provider: p.env.keys().any(|k| k.ends_with("BASE_URL")) || p.files.contains_key("config.toml"),
        })
        .collect();
    // エージェント名そのものも、既存のログインを使う既定のプロファイルとして選べる
    for agent in cfg.agents.keys() {
        out.push(ProfileSummary {
            name: agent.clone(),
            agent: agent.clone(),
            label: "default".into(),
            isolate: false,
            keyed: false,
            custom_provider: false,
        });
    }
    out
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
) -> CmdResult<SessionRecord> {
    let repo = PathBuf::from(expand_home(&repo));
    state
        .engine
        .start_session(StartSession { profile, title, repo, worktree })
        .await
        .map_err(err)
}

#[tauri::command]
async fn reopen_session(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.reopen_session(&id).await.map_err(err)
}

#[tauri::command]
async fn close_session(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.close_session(&id).await.map_err(err)
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
async fn respond_permission(
    state: State<'_, AppState>,
    id: String,
    permission_id: String,
    option_id: Option<String>,
) -> CmdResult<()> {
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

/// リポジトリを選ぶ欄の補完（dirs.rs）
#[tauri::command]
async fn complete_dirs(input: String) -> Vec<dirs::DirCandidate> {
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default());
    dirs::complete(&input, &home)
}

fn expand_home(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", std::env::var("HOME").unwrap_or_default()),
        None => p.to_string(),
    }
}

/// 開発中は、ワークスペースの target にある模擬エージェントを使う
fn resolve_mock_agent(config: &mut Config) {
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
    /// キーを渡す環境変数
    key_var: Option<String>,
    /// キーチェーンのアカウント名
    key_account: Option<String>,
    key_set: bool,
    /// 保存したキーの末尾 4 文字（どのキーかを見分けるため。全体は画面に渡さない）
    key_tail: Option<String>,
    /// 同じキーを使っているほかのプロファイル
    shared_with: Vec<String>,
    /// 専用ディレクトリにするときに差し替える環境変数
    config_dir_env: Option<String>,
}

#[tauri::command]
fn profile_detail(state: State<'_, AppState>, name: String) -> CmdResult<ProfileDetail> {
    let cfg = state.config.read().unwrap();
    let def = cfg.profiles.get(&name).ok_or_else(|| format!("プロファイル '{name}' はありません"))?;
    let form = edit::describe(&name, def);
    let account = edit::key_account(&name, def);
    let value = account.as_ref().and_then(|(_, a)| state.secrets.get(a).ok());
    let shared_with = match &account {
        Some((_, a)) => cfg
            .profiles
            .iter()
            .filter(|(n, d)| **n != name && edit::key_account(n, d).is_some_and(|(_, b)| &b == a))
            .map(|(n, _)| n.clone())
            .collect(),
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

/// 保存する。`original` と名前が違えば名前を変える（キーチェーンの中身も移す）
#[tauri::command]
fn save_profile(state: State<'_, AppState>, form: ProfileForm, original: Option<String>) -> CmdResult<()> {
    let (def, old_account) = {
        let cfg = state.config.read().unwrap();
        let renaming = original.as_deref().is_some_and(|o| o != form.name);
        if original.is_none() || renaming {
            edit::validate_name(&form.name, &cfg).map_err(err)?;
            if cfg.profiles.contains_key(&form.name) {
                return Err(format!("'{}' という名前のプロファイルはもうあります", form.name));
            }
        }
        if !cfg.agents.contains_key(&form.agent) {
            return Err(format!("エージェント '{}' はありません", form.agent));
        }
        let existing = original.as_ref().and_then(|o| cfg.profiles.get(o));
        let def = edit::to_def(&form, existing).map_err(err)?;
        let old_account = original.as_ref().zip(existing).and_then(|(o, d)| edit::key_account(o, d));
        (def, old_account)
    };
    // 名前を変えたら、このプロファイル専用のキーを新しい名前のアカウントへ移す
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

/// キーをキーチェーンに保存する（値はログにも画面にも戻さない）
#[tauri::command]
fn set_profile_key(state: State<'_, AppState>, name: String, value: String) -> CmdResult<()> {
    let value = value.trim();
    if value.is_empty() {
        return Err("キーが空です".into());
    }
    let cfg = state.config.read().unwrap();
    let def = cfg.profiles.get(&name).ok_or_else(|| format!("プロファイル '{name}' はありません"))?;
    let (_, account) = edit::key_account(&name, def).ok_or("このプロファイルはキーを使いません")?;
    state.secrets.set(&account, value).map_err(err)
}

/// 削除する。このプロファイル専用のキーもキーチェーンから消す（共有のキーは残す）
#[tauri::command]
fn delete_profile(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    let own = {
        let cfg = state.config.read().unwrap();
        let def = cfg.profiles.get(&name).ok_or_else(|| format!("プロファイル '{name}' はありません"))?;
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
    /// 設定に従って worktree を片付けた
    cleaned: bool,
}

#[tauri::command]
async fn merge_session(state: State<'_, AppState>, id: String) -> CmdResult<MergeResult> {
    let target = state.engine.merge(&id).map_err(err)?;
    let cleanup = state.settings.read().unwrap().cleanup_after_merge;
    if cleanup {
        state.engine.cleanup_worktree(&id).await.map_err(|e| format!("{target} には取り込みましたが、片付けに失敗しました: {e}"))?;
    }
    Ok(MergeResult { target, cleaned: cleanup })
}

#[tauri::command]
async fn create_pr(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    state.engine.create_pr(&id).map_err(err)
}

/// 会話の中のリンクを、既定のブラウザで開く（WebView の中で開くとアプリの画面が替わってしまう）。
/// http / https / mailto だけを通す
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    let ok = ["http://", "https://", "mailto:"].iter().any(|p| url.starts_with(p));
    if !ok || url.chars().any(char::is_control) {
        return Err("このリンクは開けません".into());
    }
    std::process::Command::new("open").arg(&url).spawn().map_err(err)?;
    Ok(())
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

/// セッションの名前を変える
#[tauri::command]
fn rename_session(state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err("名前が空です".into());
    }
    state.engine.store().rename_by_user(&id, title).map_err(err)
}

#[tauri::command]
async fn check_profile(state: State<'_, AppState>, name: String) -> CmdResult<plyfold_core::check::CheckResult> {
    Ok(state.engine.check_profile(&name).await)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state_dir = default_state_dir();
            let config_path = state_dir.join("config.toml");
            let mut config = Config::load(&config_path)?;
            resolve_mock_agent(&mut config);
            let secrets = Arc::new(KeychainStore::new(KEYCHAIN_SERVICE));
            let settings = load_settings(&state_dir.join("settings.json"));
            let engine = Engine::open(EngineOptions {
                state_dir: state_dir.clone(),
                config: config.clone(),
                secrets: secrets.clone(),
                stall_after: Duration::from_secs(settings.stall_seconds),
            })?;

            // エンジンのイベントをそのまま画面へ
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

            app.manage(AppState { engine, config: RwLock::new(config), config_path, secrets, state_dir, settings: RwLock::new(settings) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            list_sessions,
            session_history,
            usage_summary,
            complete_dirs,
            open_url,
            start_session,
            reopen_session,
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
            open_in_editor,
            get_settings,
            save_settings,
            reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("Plyfold を起動できません");
}
