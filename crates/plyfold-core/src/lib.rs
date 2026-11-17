//! The Plyfold engine: ties together profiles, worktrees, ACP and the session log
//!
//! The UI (Tauri, etc.) talks only to this engine. State changes are delivered as [`EngineEvent`]s.
//! - A session (the record) and the agent process (the execution) are separate. Stopping the process keeps the record, and `reopen_session` resumes it
//! - Permission requests are forwarded to the UI, and the answer comes back through `respond_permission`
//! - If nothing arrives for a while during a turn, the session becomes `Stalled` (testing turned up agents that never finish)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use plyfold_acp::{AcpClient, AcpError, AgentMessage, Direction, FrameSink};
use plyfold_profile::{Config, ProfileError, SecretStore};
use plyfold_store::{EventKind, NewSession, SessionRecord, SessionStatus, Store, StoreError};
use plyfold_worktree::{Diff, Worktree, WorktreeError, Worktrees};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};

pub use plyfold_store::SessionStatus as Status;

pub mod attach;
pub mod check;
pub use attach::Attachment;
pub mod info;
pub mod usage;
pub use usage::ProfileUsage;
pub use info::{Category, Choice, ConfigOption, Cost, LiveTurn, SessionInfo, TokenUsage, TurnStats};
use info::TurnClock;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Profile(#[from] ProfileError),
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
    #[error(transparent)]
    Acp(#[from] AcpError),
    #[error("{}", plyfold_i18n::tr!("セッション {} のエージェントは動いていません", "The agent for session {} is not running", "会话 {} 的代理未在运行", .0))]
    NotRunning(String),
    #[error("{}", plyfold_i18n::tr!("セッション {} のエージェントはもう動いています", "The agent for session {} is already running", "会话 {} 的代理已在运行", .0))]
    AlreadyRunning(String),
    #[error("{}", plyfold_i18n::tr!("セッション {} はターンの途中です", "Session {} is in the middle of a turn", "会话 {} 的轮次尚未结束", .0))]
    Busy(String),
    #[error("{}", plyfold_i18n::tr!("権限確認 {} は見つかりません（すでに返事済みか、ターンが終わっています）", "Permission request {} not found (already answered, or the turn has ended)", "找不到权限请求 {}（已答复，或轮次已结束）", .0))]
    UnknownPermission(String),
    #[error("{}", plyfold_i18n::tr!("セッション {} には作業場所がありません", "Session {} has no workspace", "会话 {} 没有工作区", .0))]
    NoWorkspace(String),
    #[error("{}", plyfold_i18n::tr!("このエージェントには {:?} の設定項目がありません", "This agent has no {:?} option", "此代理没有 {:?} 设置项", .0))]
    NoSuchOption(Category),
    #[error("{}", plyfold_i18n::tr!("添えたものを読めません: {}", "Cannot read the attachment: {}", "无法读取附件：{}", .0))]
    Attachment(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionChoice {
    pub option_id: String,
    pub name: String,
    /// allow_once / allow_always / reject_once / reject_always
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    SessionCreated { session: SessionRecord },
    Status { session_id: String, status: SessionStatus },
    /// The `update` part of session/update (raw JSON; the UI renders each kind)
    Update { session_id: String, update: Value },
    PermissionRequested {
        session_id: String,
        permission_id: String,
        title: String,
        tool_call: Value,
        options: Vec<PermissionChoice>,
    },
    PermissionResolved { session_id: String, permission_id: String, option_id: Option<String> },
    TurnEnded { session_id: String, stop_reason: Option<String>, error: Option<String> },
    /// Something to tell the user (launch failures, no response, reopen results, etc.)
    Notice { session_id: String, message: String },
    /// Config options and usage (sent in full on every change; every 0.5 s while streaming)
    Info { session_id: String, info: Box<SessionInfo> },
    /// The session was renamed to a title the agent set
    Renamed { session_id: String, title: String },
}

pub struct EngineOptions {
    pub state_dir: PathBuf,
    pub config: Config,
    pub secrets: Arc<dyn SecretStore>,
    /// Mark the session Stalled if nothing arrives for this long during a turn
    pub stall_after: Duration,
}

pub struct StartSession {
    /// Profile name or agent name
    pub profile: String,
    pub title: String,
    /// Repository (or directory) to work in
    pub repo: PathBuf,
    /// If true, create a dedicated worktree for the session (repo must be a git repository)
    pub worktree: bool,
}

struct Live {
    client: AcpClient,
    acp_sid: Mutex<String>,
    /// permission_id → JSON-RPC request ID
    permissions: Mutex<HashMap<String, Value>>,
    last_activity: Mutex<Instant>,
    in_turn: AtomicBool,
    stalled: AtomicBool,
    closing: AtomicBool,
    /// Number of AgentMessages the pump has finished processing (compared against a barrier)
    processed: AtomicU64,
    progress: tokio::sync::Notify,
    info: Mutex<SessionInfo>,
    clock: Mutex<Option<TurnClock>>,
    last_live_emit: Mutex<Instant>,
    /// True while session/load is resending the conversation history. Those updates are recorded and still update
    /// SessionInfo, but are not sent to the UI: it already has the conversation from the event log, and showing the
    /// resend would duplicate it and push the message being sent above the earlier output
    replaying: AtomicBool,
}

impl Live {
    /// Wait until the pump has processed every AgentMessage up to the barrier (with a safety timeout)
    async fn wait_processed(&self, barrier: u64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let notified = self.progress.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.processed.load(Ordering::SeqCst) >= barrier || Instant::now() >= deadline {
                return;
            }
            let _ = tokio::time::timeout(Duration::from_millis(200), notified).await;
        }
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }
    fn sid(&self) -> String {
        self.acp_sid.lock().unwrap().clone()
    }
}

struct Inner {
    store: Store,
    /// Replaced when profiles are edited from the UI (running sessions are unaffected)
    config: RwLock<Config>,
    secrets: Arc<dyn SecretStore>,
    state_dir: PathBuf,
    worktrees: Worktrees,
    live: Mutex<HashMap<String, Arc<Live>>>,
    tx: broadcast::Sender<EngineEvent>,
    stall_after_ms: AtomicU64,
    perm_seq: AtomicU64,
}

impl Inner {
    fn emit(&self, e: EngineEvent) {
        let _ = self.tx.send(e);
    }

    fn set_status(&self, id: &str, status: SessionStatus) {
        if let Err(e) = self.store.set_status(id, status) {
            tracing::warn!("cannot save state: {e}");
        }
        self.emit(EngineEvent::Status { session_id: id.into(), status });
    }

    fn notice(&self, id: &str, message: impl Into<String>) {
        let message = message.into();
        let _ = self.store.append_event(id, EventKind::Note, &message);
        self.emit(EngineEvent::Notice { session_id: id.into(), message });
    }

    fn live(&self, id: &str) -> Result<Arc<Live>, CoreError> {
        self.live.lock().unwrap().get(id).cloned().ok_or_else(|| CoreError::NotRunning(id.into()))
    }
}

/// Event-log notes around the history that session/load resends. The UI skips the updates between them
/// when it rebuilds a conversation from the log, and never shows these notes
pub const REPLAY_BEGIN: &str = "replay:begin";
pub const REPLAY_END: &str = "replay:end";

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    pub fn open(opts: EngineOptions) -> Result<Self, CoreError> {
        let store = Store::open(&opts.state_dir.join("plyfold.db"))?;
        // Sessions that were running in the previous launch no longer have a process, so mark them Closed
        for s in store.list_sessions()? {
            if !matches!(s.status, SessionStatus::Closed | SessionStatus::Error) {
                store.set_status(&s.id, SessionStatus::Closed)?;
            }
        }
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                config: RwLock::new(opts.config),
                secrets: opts.secrets,
                worktrees: Worktrees::new(opts.state_dir.join("worktrees")),
                state_dir: opts.state_dir,
                live: Mutex::new(HashMap::new()),
                tx: broadcast::channel(4096).0,
                stall_after_ms: AtomicU64::new(opts.stall_after.as_millis() as u64),
                perm_seq: AtomicU64::new(0),
            }),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.inner.tx.subscribe()
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }

    /// Connection test (not recorded)
    pub async fn check_profile(&self, profile: &str) -> check::CheckResult {
        let config = self.inner.config.read().unwrap().clone();
        check::check_profile(&config, profile, &self.inner.state_dir, self.inner.secrets.as_ref()).await
    }

    /// Replace the profile config (takes effect for the next session launched)
    pub fn set_config(&self, config: Config) {
        *self.inner.config.write().unwrap() = config;
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.inner.live.lock().unwrap().contains_key(id)
    }

    pub async fn start_session(&self, req: StartSession) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        let agent = inner
            .config
            .read()
            .unwrap()
            .profiles
            .get(&req.profile)
            .map(|p| p.agent.clone())
            .unwrap_or_else(|| req.profile.clone());
        let rec = inner.store.create_session(NewSession {
            title: req.title,
            profile: req.profile.clone(),
            agent,
            ..Default::default()
        })?;
        inner.emit(EngineEvent::SessionCreated { session: rec.clone() });

        let prepared: Result<PathBuf, CoreError> = (|| {
            if req.worktree {
                let wt = inner.worktrees.create(&req.repo, &rec.id, None)?;
                inner.store.set_workspace(
                    &rec.id,
                    Some(&wt.repo.display().to_string()),
                    Some(&wt.path.display().to_string()),
                    Some(&wt.branch),
                    Some(&wt.base),
                )?;
                Ok(wt.path)
            } else {
                inner.store.set_workspace(&rec.id, Some(&req.repo.display().to_string()), None, None, None)?;
                Ok(req.repo.clone())
            }
        })();
        let cwd = match prepared {
            Ok(c) => c,
            Err(e) => {
                inner.notice(&rec.id, plyfold_i18n::tr!("作業場所を用意できません: {e}", "Cannot prepare the workspace: {e}", "无法准备工作区：{e}"));
                inner.set_status(&rec.id, SessionStatus::Error);
                return Err(e);
            }
        };
        self.launch(&rec.id, &req.profile, &cwd, None).await?;
        Ok(inner.store.get_session(&rec.id)?)
    }

    /// Restart the agent for a stopped session. If supported, session/load restores the full context
    pub async fn reopen_session(&self, id: &str) -> Result<(), CoreError> {
        if self.is_running(id) {
            return Err(CoreError::AlreadyRunning(id.into()));
        }
        let rec = self.inner.store.get_session(id)?;
        let cwd = rec
            .worktree_path
            .clone()
            .or(rec.repo_path.clone())
            .ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        self.launch(id, &rec.profile, Path::new(&cwd), rec.acp_session_id.clone()).await
    }

    async fn launch(&self, id: &str, profile: &str, cwd: &Path, reopen: Option<String>) -> Result<(), CoreError> {
        let inner = self.inner.clone();
        inner.set_status(id, SessionStatus::Starting);
        let result: Result<(), CoreError> = async {
            let resolved = inner.config.read().unwrap().resolve(profile, &inner.state_dir, cwd, inner.secrets.as_ref())?;
            let mut msg = format!("起動: {} {}", resolved.spawn.command, resolved.spawn.args.join(" "));
            if !resolved.env_summary.is_empty() {
                msg += &format!("（{}）", resolved.env_summary.join(", "));
            }
            inner.notice(id, msg);

            // Hold a weak reference to avoid an Inner → Live → connection → sink → Inner cycle
            let sink: FrameSink = {
                let weak = Arc::downgrade(&inner);
                let id = id.to_string();
                Arc::new(move |dir, line: &str| {
                    let Some(inner) = weak.upgrade() else { return };
                    let kind = if dir == Direction::In { EventKind::FrameIn } else { EventKind::FrameOut };
                    let _ = inner.store.append_event(&id, kind, line);
                })
            };
            let (client, rx) = AcpClient::connect(&resolved.spawn, Some(sink)).await?;
            let live = Arc::new(Live {
                client,
                acp_sid: Mutex::new(String::new()),
                permissions: Mutex::new(HashMap::new()),
                last_activity: Mutex::new(Instant::now()),
                in_turn: AtomicBool::new(false),
                stalled: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                processed: AtomicU64::new(0),
                progress: tokio::sync::Notify::new(),
                info: Mutex::new(SessionInfo::default()),
                clock: Mutex::new(None),
                last_live_emit: Mutex::new(Instant::now()),
                replaying: AtomicBool::new(false),
            });
            // Start receiving first so the history resent by session/load is captured
            tokio::spawn(pump(inner.clone(), id.to_string(), live.clone(), rx));

            let opened: Result<String, CoreError> = async {
                // Why reopening failed (reported when continuing in a new session)
                let mut fallback = None;
                if let Some(old) = &reopen {
                    if live.client.supports_load_session() {
                        // Mark the resent history in the event log so it is not rebuilt as a second copy of the conversation
                        let _ = inner.store.append_event(id, EventKind::Note, REPLAY_BEGIN);
                        live.replaying.store(true, Ordering::SeqCst);
                        let loaded = live.client.load_session(old, cwd).await;
                        if let Ok((_, barrier)) = &loaded {
                            live.wait_processed(*barrier).await;
                        }
                        live.replaying.store(false, Ordering::SeqCst);
                        let _ = inner.store.append_event(id, EventKind::Note, REPLAY_END);
                        match loaded {
                            Ok((resp, _)) => {
                                live.info.lock().unwrap().apply_session_response(&resp);
                                inner.notice(id, plyfold_i18n::tr!("session/load で開き直しました（履歴はエージェントから再送されます）", "Reopened with session/load (the agent resends the history)", "已通过 session/load 重新打开（历史记录由代理重新发送）"));
                                return Ok(old.clone());
                            }
                            // The agent has no record of the conversation (e.g. it exited before saving). Continue in a new session
                            Err(AcpError::Rpc { code: -32002, .. }) => {
                                fallback = Some(plyfold_i18n::tr!(
                                    "エージェントの側にこの会話の記録が見つからないため、新しいセッションを作りました（文脈は引き継がれません。Plyfold の記録は残っています）",
                                    "The agent has no record of this conversation, so a new session was created (context is not carried over; Plyfold keeps its own record)",
                                    "代理端找不到此对话的记录，因此新建了会话（上下文不会延续。Plyfold 的记录仍会保留）"
                                ));
                            }
                            Err(e) => return Err(e.into()),
                        }
                    } else {
                        fallback = Some(plyfold_i18n::tr!(
                            "このエージェントは開き直しに対応していないため、新しいセッションを作りました（文脈は引き継がれません）",
                            "This agent cannot reopen sessions, so a new session was created (context is not carried over)",
                            "此代理不支持重新打开会话，因此新建了会话（上下文不会延续）"
                        ));
                    }
                }
                {
                    {
                        let r = live.client.new_session(cwd).await?;
                        let sid = r.session_id.0.to_string();
                        live.info.lock().unwrap().apply_session_response(&serde_json::to_value(&r).unwrap_or_default());
                        if let Some(msg) = fallback {
                            inner.notice(id, msg);
                        }
                        inner.store.set_acp_session_id(id, &sid)?;
                        if let Some(mode) = &resolved.default_mode {
                            live.client.set_mode(&sid, mode).await?;
                            live.info.lock().unwrap().current_mode = Some(mode.clone());
                        }
                        Ok(sid)
                    }
                }
            }
            .await;
            match opened {
                Ok(sid) => *live.acp_sid.lock().unwrap() = sid,
                Err(e) => {
                    live.closing.store(true, Ordering::SeqCst);
                    let tail = live.client.connection().stderr_tail();
                    live.client.shutdown().await;
                    if !tail.is_empty() {
                        inner.notice(id, plyfold_i18n::tr!("stderr の最後:\n{}", "Last stderr output:\n{}", "stderr 的最后几行：\n{}", tail.join("\n")));
                    }
                    return Err(e);
                }
            }
            inner.live.lock().unwrap().insert(id.to_string(), live.clone());
            emit_info(&inner, id, &live);
            tokio::spawn(watchdog(inner.clone(), id.to_string(), live));
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                inner.set_status(id, SessionStatus::Idle);
                Ok(())
            }
            Err(e) => {
                inner.notice(id, plyfold_i18n::tr!("エージェントを起動できません: {e}", "Cannot start the agent: {e}", "无法启动代理：{e}"));
                inner.set_status(id, SessionStatus::Error);
                Err(e)
            }
        }
    }

    /// Start a turn. Does not wait for it to finish (TurnEnded arrives when it does)
    pub fn prompt(&self, id: &str, text: &str) -> Result<(), CoreError> {
        self.prompt_with(id, text, &[])
    }

    /// Start a turn with images or files attached
    pub fn prompt_with(&self, id: &str, text: &str, attachments: &[Attachment]) -> Result<(), CoreError> {
        let inner = self.inner.clone();
        let live = inner.live(id)?;
        // For agents without image support, write images to the state dir and pass them as links
        let blocks = attach::prompt_blocks(text, attachments, live.client.supports_images(), &inner.state_dir.join("attachments"))
            .map_err(|e| CoreError::Attachment(e.to_string()))?;
        if live.in_turn.swap(true, Ordering::SeqCst) {
            return Err(CoreError::Busy(id.into()));
        }
        live.touch();
        live.stalled.store(false, Ordering::SeqCst);
        *live.clock.lock().unwrap() = Some(TurnClock::new());
        live.info.lock().unwrap().live = Some(LiveTurn::default());
        inner.set_status(id, SessionStatus::Working);
        let id = id.to_string();
        tokio::spawn(async move {
            let r = live.client.prompt_blocks(&live.sid(), blocks).await;
            live.in_turn.store(false, Ordering::SeqCst);
            live.permissions.lock().unwrap().clear();
            match r {
                Ok(turn) => {
                    // Report the end of the turn only after this turn's notifications have been delivered
                    live.wait_processed(turn.barrier).await;
                    finish_turn(&inner, &id, &live, &turn.raw["usage"]);
                    let stop = serde_json::to_value(turn.response.stop_reason).ok().and_then(|v| v.as_str().map(str::to_string));
                    inner.emit(EngineEvent::TurnEnded { session_id: id.clone(), stop_reason: stop, error: None });
                }
                Err(e) => {
                    finish_turn(&inner, &id, &live, &Value::Null);
                    inner.notice(&id, plyfold_i18n::tr!("ターンがエラーで終わりました: {e}", "The turn ended with an error: {e}", "轮次因错误而结束：{e}"));
                    inner.emit(EngineEvent::TurnEnded { session_id: id.clone(), stop_reason: None, error: Some(e.to_string()) });
                }
            }
            if !live.closing.load(Ordering::SeqCst) {
                inner.set_status(&id, SessionStatus::Idle);
            }
        });
        Ok(())
    }

    /// Cancel. Pending permission requests are answered with "cancelled" (per the ACP spec)
    pub async fn cancel(&self, id: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let pending: Vec<(String, Value)> = live.permissions.lock().unwrap().drain().collect();
        for (pid, request_id) in pending {
            live.client.respond_permission(request_id, None).await?;
            self.inner.emit(EngineEvent::PermissionResolved { session_id: id.into(), permission_id: pid, option_id: None });
        }
        live.client.cancel(&live.sid()).await?;
        Ok(())
    }

    /// An option_id of None is treated as a cancel
    pub async fn respond_permission(&self, id: &str, permission_id: &str, option_id: Option<&str>) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let request_id = live
            .permissions
            .lock()
            .unwrap()
            .remove(permission_id)
            .ok_or_else(|| CoreError::UnknownPermission(permission_id.into()))?;
        live.client.respond_permission(request_id, option_id).await?;
        live.touch();
        self.inner.emit(EngineEvent::PermissionResolved {
            session_id: id.into(),
            permission_id: permission_id.into(),
            option_id: option_id.map(str::to_string),
        });
        if live.in_turn.load(Ordering::SeqCst) && live.permissions.lock().unwrap().is_empty() {
            self.inner.set_status(id, SessionStatus::Working);
        }
        Ok(())
    }

    /// Current session info (None if the agent is not running)
    pub fn session_info(&self, id: &str) -> Option<SessionInfo> {
        self.inner.live(id).ok().map(|l| l.info.lock().unwrap().clone())
    }

    /// Change a config option by ID
    pub async fn set_config_option(&self, id: &str, config_id: &str, value: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let opts = live.client.set_config_option(&live.sid(), config_id, value).await?;
        live.info.lock().unwrap().set_config(&opts);
        emit_info(&self.inner, id, &live);
        Ok(())
    }

    /// Change model / effort / mode without caring how each agent names them.
    /// For mode, fall back to the legacy session/set_mode when configOptions lacks it
    pub async fn set_by_category(&self, id: &str, category: Category, value: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let config_id = live.info.lock().unwrap().option(category).map(|o| o.id.clone());
        match (config_id, category) {
            (Some(cid), _) => self.set_config_option(id, &cid, value).await,
            (None, Category::Mode) => self.set_mode(id, value).await,
            (None, c) => Err(CoreError::NoSuchOption(c)),
        }
    }

    pub async fn set_mode(&self, id: &str, mode_id: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        live.client.set_mode(&live.sid(), mode_id).await?;
        live.info.lock().unwrap().current_mode = Some(mode_id.to_string());
        emit_info(&self.inner, id, &live);
        Ok(())
    }

    /// Stop the agent (the record and worktree are kept)
    pub async fn close_session(&self, id: &str) -> Result<(), CoreError> {
        let live = self.inner.live.lock().unwrap().remove(id);
        if let Some(live) = live {
            live.closing.store(true, Ordering::SeqCst);
            live.client.shutdown().await;
        }
        self.inner.set_status(id, SessionStatus::Closed);
        Ok(())
    }

    /// Delete the session and its record. With `remove_worktree`, also delete the worktree and branch (work is lost)
    pub async fn delete_session(&self, id: &str, remove_worktree: bool) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        self.close_session(id).await?;
        if remove_worktree && let Some(wt) = worktree_of(&rec) {
            self.inner.worktrees.remove(&wt, true)?;
        }
        self.inner.store.delete_session(id)?;
        Ok(())
    }

    /// Worktree diff (from the commit it was created at to the current working tree)
    pub fn diff(&self, id: &str) -> Result<Diff, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        Ok(plyfold_worktree::diff(&wt)?)
    }

    fn idle_worktree(&self, id: &str) -> Result<Worktree, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        if matches!(rec.status, SessionStatus::Working | SessionStatus::AwaitingPermission | SessionStatus::Stalled | SessionStatus::Starting) {
            return Err(CoreError::Busy(id.into()));
        }
        worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))
    }

/// The directory a session works in (its worktree, or the repository itself) and the branch to compare it with:
    /// the branch it will be merged into for a worktree, the remote's default branch otherwise
    fn git_dir(&self, id: &str) -> Result<(PathBuf, Option<String>), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        if let Some(wt) = worktree_of(&rec) {
            let base = plyfold_worktree::ops::status(&wt).ok().and_then(|s| s.target);
            return Ok((wt.path, base));
        }
        let dir = PathBuf::from(rec.repo_path.ok_or_else(|| CoreError::NoWorkspace(id.into()))?);
        let base = plyfold_worktree::remote::remote_default(&dir);
        Ok((dir, base))
    }

    pub fn git_info(&self, id: &str) -> Result<plyfold_worktree::remote::GitInfo, CoreError> {
        let (dir, base) = self.git_dir(id)?;
        Ok(plyfold_worktree::remote::info(&dir, base.as_deref())?)
    }

    pub fn git_fetch(&self, id: &str) -> Result<(), CoreError> {
        let (dir, _) = self.git_dir(id)?;
        Ok(plyfold_worktree::remote::fetch(&dir)?)
    }

    pub fn git_push(&self, id: &str) -> Result<String, CoreError> {
        let (dir, _) = self.git_dir(id)?;
        let upstream = plyfold_worktree::remote::push(&dir)?;
        self.inner.notice(id, plyfold_i18n::tr!("{upstream} に push しました", "Pushed to {upstream}", "已推送到 {upstream}"));
        Ok(upstream)
    }

    /// Pull (fast-forward only). Not mid-turn: it changes files under the agent
    pub fn git_pull(&self, id: &str) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        if matches!(rec.status, SessionStatus::Working | SessionStatus::AwaitingPermission | SessionStatus::Stalled | SessionStatus::Starting) {
            return Err(CoreError::Busy(id.into()));
        }
        let (dir, _) = self.git_dir(id)?;
        plyfold_worktree::remote::pull(&dir)?;
        self.inner.notice(id, plyfold_i18n::tr!("リモートの新しいコミットを取り込みました", "Pulled the new commits from the remote", "已拉取远程的新提交"));
        Ok(())
    }

    pub fn pull_request(&self, id: &str) -> Result<Option<plyfold_worktree::remote::PullRequest>, CoreError> {
        let (dir, _) = self.git_dir(id)?;
        Ok(plyfold_worktree::remote::pull_request(&dir)?)
    }

        pub fn worktree_status(&self, id: &str) -> Result<plyfold_worktree::WtStatus, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        Ok(plyfold_worktree::ops::status(&wt)?)
    }

    /// Commit every change in the working tree (not allowed mid-turn)
    pub fn commit(&self, id: &str, message: &str) -> Result<String, CoreError> {
        let wt = self.idle_worktree(id)?;
        let hash = plyfold_worktree::ops::commit(&wt, message)?;
        self.inner.notice(id, plyfold_i18n::tr!("コミットしました: {hash} {}", "Committed: {hash} {}", "已提交：{hash} {}", message.lines().next().unwrap_or("")));
        Ok(hash)
    }

    /// Merge into the branch currently checked out in the original repository
    pub fn merge(&self, id: &str) -> Result<String, CoreError> {
        let wt = self.idle_worktree(id)?;
        let target = plyfold_worktree::ops::merge(&wt)?;
        self.inner.notice(id, plyfold_i18n::tr!("{} を {target} に取り込みました", "Merged {} into {target}", "已将 {} 合并到 {target}", wt.branch));
        Ok(target)
    }

    /// Push the branch and open a PR. Returns its URL
    pub fn create_pr(&self, id: &str) -> Result<String, CoreError> {
        let wt = self.idle_worktree(id)?;
        let title = self.inner.store.get_session(id)?.title;
        let url = plyfold_worktree::ops::create_pr(&wt, &title)?;
        self.inner.notice(id, plyfold_i18n::tr!("PR を作りました: {url}", "Created a PR: {url}", "已创建 PR：{url}"));
        Ok(url)
    }

    pub fn open_in_editor(&self, id: &str, prefer: &str) -> Result<String, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        Ok(plyfold_worktree::ops::open_in_editor(&wt, prefer)?)
    }

    /// Cleanup after merging: stop the agent and delete the worktree and branch. The record stays; reopening runs in the original repository
    pub async fn cleanup_worktree(&self, id: &str) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        self.close_session(id).await?;
        self.inner.worktrees.remove(&wt, true)?;
        self.inner.store.set_workspace(id, rec.repo_path.as_deref(), None, None, None)?;
        self.inner.notice(id, plyfold_i18n::tr!("worktree と枝 {} を片付けました", "Removed the worktree and branch {}", "已清理 worktree 和分支 {}", wt.branch));
        Ok(())
    }

    /// Change the no-response timeout (takes effect from the next watchdog check)
    pub fn set_stall_after(&self, d: Duration) {
        self.inner.stall_after_ms.store(d.as_millis() as u64, Ordering::SeqCst);
    }

    /// Reset the working tree to the base commit
    pub fn discard(&self, id: &str) -> Result<(), CoreError> {
        let wt = self.idle_worktree(id)?;
        plyfold_worktree::ops::discard(&wt)?;
        self.inner.notice(id, plyfold_i18n::tr!("変更を破棄して、{} に戻しました", "Discarded the changes and reset to {}", "已放弃更改，并恢复到 {}", &wt.base[..wt.base.len().min(7)]));
        Ok(())
    }
}

fn worktree_of(rec: &SessionRecord) -> Option<Worktree> {
    Some(Worktree {
        repo: PathBuf::from(rec.repo_path.as_ref()?),
        path: PathBuf::from(rec.worktree_path.as_ref()?),
        branch: rec.branch.clone()?,
        base: rec.base_ref.clone()?,
    })
}

async fn pump(inner: Arc<Inner>, id: String, live: Arc<Live>, mut rx: mpsc::UnboundedReceiver<AgentMessage>) {
    while let Some(msg) = rx.recv().await {
        let closed = matches!(msg, AgentMessage::Closed);
        handle(&inner, &id, &live, msg).await;
        if closed {
            break;
        }
        live.processed.fetch_add(1, Ordering::SeqCst);
        live.progress.notify_waiters();
    }
}

async fn handle(inner: &Arc<Inner>, id: &str, live: &Arc<Live>, msg: AgentMessage) {
    let id = id.to_string();
    {
        match msg {
            AgentMessage::Update { raw, .. } => {
                live.touch();
                if live.stalled.swap(false, Ordering::SeqCst) && live.in_turn.load(Ordering::SeqCst) {
                    inner.set_status(&id, SessionStatus::Working);
                }
                let update = &raw["update"];
                let changed = live.info.lock().unwrap().apply_update(update);
                let text = matches!(update["sessionUpdate"].as_str(), Some("agent_message_chunk" | "agent_thought_chunk"))
                    .then(|| update["content"]["text"].as_str())
                    .flatten();
                let mut live_due = false;
                if let Some(t) = text
                    && let Some(clock) = live.clock.lock().unwrap().as_mut()
                {
                    clock.on_text(t);
                    let mut last = live.last_live_emit.lock().unwrap();
                    if last.elapsed() >= Duration::from_millis(500) {
                        *last = Instant::now();
                        live.info.lock().unwrap().live = Some(clock.live());
                        live_due = true;
                    }
                }
                // Title set by the agent (Claude's session_info_update). Applied unless the user has renamed the session
                if update["sessionUpdate"] == "session_info_update"
                    && let Some(title) = update["title"].as_str().map(str::trim).filter(|t| !t.is_empty())
                    && matches!(inner.store.set_title_from_agent(&id, title), Ok(true))
                {
                    inner.emit(EngineEvent::Renamed { session_id: id.clone(), title: title.to_string() });
                }
                // History resent by session/load stays out of the live transcript (see Live::replaying)
                if !live.replaying.load(Ordering::SeqCst) {
                    inner.emit(EngineEvent::Update { session_id: id.clone(), update: update.clone() });
                }
                if changed || live_due {
                    emit_info(inner, &id, live);
                }
            }
            AgentMessage::PermissionRequest { request_id, request } => {
                live.touch();
                let pid = format!("perm-{}", inner.perm_seq.fetch_add(1, Ordering::SeqCst));
                live.permissions.lock().unwrap().insert(pid.clone(), request_id);
                let v = serde_json::to_value(&*request).unwrap_or(Value::Null);
                let options = v["options"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|o| PermissionChoice {
                                option_id: o["optionId"].as_str().unwrap_or_default().into(),
                                name: o["name"].as_str().unwrap_or_default().into(),
                                kind: o["kind"].as_str().unwrap_or_default().into(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                inner.set_status(&id, SessionStatus::AwaitingPermission);
                inner.emit(EngineEvent::PermissionRequested {
                    session_id: id.clone(),
                    permission_id: pid,
                    title: v["toolCall"]["title"].as_str().map(str::to_string).unwrap_or_else(|| plyfold_i18n::tr!("（タイトルなし）", "(untitled)", "（无标题）")),
                    tool_call: v["toolCall"].clone(),
                    options,
                });
            }
            AgentMessage::OtherRequest { request_id, method, .. } => {
                let _ = live.client.respond_unsupported(request_id).await;
                inner.notice(&id, plyfold_i18n::tr!("未対応のリクエスト {method} を断りました", "Declined the unsupported request {method}", "已拒绝不支持的请求 {method}"));
            }
            AgentMessage::OtherNotification { .. } => {}
            AgentMessage::Closed => {
                inner.live.lock().unwrap().remove(&id);
                if !live.closing.load(Ordering::SeqCst) {
                    let tail = live.client.connection().stderr_tail();
                    let mut msg = plyfold_i18n::tr!("エージェントのプロセスが終了しました", "The agent process exited", "代理进程已退出");
                    if !tail.is_empty() {
                        msg += &plyfold_i18n::tr!("\nstderr の最後:\n{}", "\nLast stderr output:\n{}", "\nstderr 的最后几行：\n{}", tail.iter().rev().take(20).rev().cloned().collect::<Vec<_>>().join("\n"));
                    }
                    inner.notice(&id, msg);
                    inner.set_status(&id, SessionStatus::Error);
                }
            }
        }
    }
}

async fn watchdog(inner: Arc<Inner>, id: String, live: Arc<Live>) {
    let tick = (Duration::from_millis(inner.stall_after_ms.load(Ordering::SeqCst)) / 4).clamp(Duration::from_millis(50), Duration::from_secs(1));
    loop {
        tokio::time::sleep(tick).await;
        if live.closing.load(Ordering::SeqCst) || !inner.live.lock().unwrap().contains_key(&id) {
            break;
        }
        let idle = live.last_activity.lock().unwrap().elapsed();
        if live.in_turn.load(Ordering::SeqCst)
            && live.permissions.lock().unwrap().is_empty()
            && idle >= Duration::from_millis(inner.stall_after_ms.load(Ordering::SeqCst))
            && !live.stalled.swap(true, Ordering::SeqCst)
        {
            inner.set_status(&id, SessionStatus::Stalled);
            inner.notice(&id, plyfold_i18n::tr!("{} 秒間、エージェントから何も届いていません", "Nothing has arrived from the agent for {} seconds", "已有 {} 秒没有收到代理的任何消息", idle.as_secs()));
        }
    }
}

fn emit_info(inner: &Inner, id: &str, live: &Live) {
    let info = live.info.lock().unwrap().clone();
    inner.emit(EngineEvent::Info { session_id: id.into(), info: Box::new(info) });
}

fn finish_turn(inner: &Inner, id: &str, live: &Live, usage: &Value) {
    let Some(clock) = live.clock.lock().unwrap().take() else { return };
    live.info.lock().unwrap().finish_turn(clock.finish(usage));
    emit_info(inner, id, live);
}
