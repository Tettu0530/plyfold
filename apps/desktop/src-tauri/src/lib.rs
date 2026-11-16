//! Plyfold のデスクトップアプリ: エンジンを Tauri のコマンドとして公開し、EngineEvent を画面へ流す

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use plyfold_core::{Category, Engine, EngineOptions, SessionInfo, StartSession};
use plyfold_profile::{Config, KeychainStore, default_state_dir};
use plyfold_store::{EventRecord, SessionRecord};
use plyfold_worktree::Diff;
use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// 画面へ流すイベントの名前
const ENGINE_EVENT: &str = "engine";
const KEYCHAIN_SERVICE: &str = "plyfold";

struct AppState {
    engine: Engine,
    config: Config,
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
    let cfg = &state.config;
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
fn prompt(state: State<'_, AppState>, id: String, text: String) -> CmdResult<()> {
    state.engine.prompt(&id, &text).map_err(err)
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
fn session_diff(state: State<'_, AppState>, id: String) -> CmdResult<Diff> {
    state.engine.diff(&id).map_err(err)
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state_dir = default_state_dir();
            let mut config = Config::load(&state_dir.join("config.toml"))?;
            resolve_mock_agent(&mut config);
            let engine = Engine::open(EngineOptions {
                state_dir,
                config: config.clone(),
                secrets: Arc::new(KeychainStore::new(KEYCHAIN_SERVICE)),
                stall_after: Duration::from_secs(120),
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

            app.manage(AppState { engine, config });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            list_sessions,
            session_history,
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
        ])
        .run(tauri::generate_context!())
        .expect("Plyfold を起動できません");
}
