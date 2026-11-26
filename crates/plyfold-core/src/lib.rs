//! The Plyfold engine: ties together profiles, worktrees, ACP and the session log
//!
//! The UI (Tauri, etc.) talks only to this engine. State changes are delivered as [`EngineEvent`]s.
//! - A session (the record) and the agent process (the execution) are separate. Stopping the process keeps the record, and `reopen_session` resumes it
//! - Permission requests are forwarded to the UI, and the answer comes back through `respond_permission`
//! - If nothing arrives for a while during a turn, the session becomes `Stalled` (testing turned up agents that never finish)

use std::collections::{HashMap, HashSet};
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
mod limits;
pub mod repos;
pub mod usage;
use info::TurnClock;
pub use info::{Category, Choice, ConfigOption, Cost, LiveTurn, SessionInfo, TokenUsage, TurnStats};
pub use usage::ProfileUsage;

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
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(
        "{}",
        plyfold_i18n::tr!(
            "会話とサイドチャットのモードは変えられません（ファイルの編集やコマンドを防ぐため）",
            "The mode of a conversation or side chat cannot be changed (it keeps files from being edited and commands from running)",
            "对话和侧边对话的模式不能更改（以防编辑文件或执行命令）"
        )
    )]
    ModeLocked,
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
    #[error("{}", plyfold_i18n::tr!("このエージェントは分岐に対応していません", "This agent cannot fork a session", "此代理不支持分叉会话"))]
    ForkUnsupported,
    #[error("{}", plyfold_i18n::tr!("セッション {} には引き継げる会話がありません", "Session {} has no conversation to fork", "会话 {} 没有可分叉的对话", .0))]
    NoConversation(String),
    #[error(
        "{}",
        plyfold_i18n::tr!(
            "セッション {} の作業場所ではエージェントが動いています。止めてから分岐するか、新しい worktree で分岐してください",
            "An agent is running in session {}'s workspace. Stop it and fork again, or fork into a new worktree",
            "会话 {} 的工作区里有代理在运行。请先停止再分叉，或在新 worktree 中分叉",
            .0
        )
    )]
    SharedWorkspace(String),
    #[error(
        "{}",
        plyfold_i18n::tr!(
            "この worktree は別のセッションも使っています。そちらのセッションを消すまで、変更は破棄できません",
            "Another session still uses this worktree, so these changes cannot be discarded yet",
            "另一个会话仍在使用此 worktree，因此现在不能放弃这些更改"
        )
    )]
    SharedWorktree,
    #[error("{}", plyfold_i18n::tr!("このエージェントは会話の一覧に対応していません", "This agent cannot list its conversations", "此代理不支持列出会话"))]
    ListUnsupported,
    #[error("{}", plyfold_i18n::tr!("このエージェントは既存の会話を開けません", "This agent cannot open an existing conversation", "此代理无法打开已有对话"))]
    CannotResume,
    #[error(
        "{}",
        plyfold_i18n::tr!("エージェントの側にこの会話の記録がありません", "The agent has no record of this conversation", "代理端没有此对话的记录")
    )]
    ConversationMissing,
    #[error("{}", plyfold_i18n::tr!("この会話はもう Plyfold にあります", "This conversation is already in Plyfold", "此对话已在 Plyfold 中"))]
    AlreadyInPlyfold,
    /// Claude Code keeps the conversation running in its background, so a second process cannot take it over
    #[error("{}", plyfold_i18n::tr!(
        "この会話は、Claude Code のバックグラウンドで実行中のため引き継げません。`claude attach {0}` で開くか、`claude stop {0}` で止めてから、もう一度試してください",
        "This conversation is running in Claude Code's background, so it cannot be continued here. Open it with `claude attach {0}` or stop it with `claude stop {0}`, then try again",
        "此对话正在 Claude Code 的后台运行，无法在此继续。请用 `claude attach {0}` 打开，或用 `claude stop {0}` 停止后再试",
        .0
    ))]
    ConversationRunning(String),
}

/// The id in "That session is running in the background (a2a3006e)", when the agent's error says so
fn background_session(error: &str) -> Option<String> {
    let rest = error.split("running in the background").nth(1)?;
    let id = rest.trim_start().strip_prefix('(').and_then(|r| r.split(')').next()).unwrap_or_default();
    Some(id.to_string())
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
    SessionCreated {
        session: SessionRecord,
    },
    Status {
        session_id: String,
        status: SessionStatus,
    },
    /// The `update` part of session/update (raw JSON; the UI renders each kind)
    Update {
        session_id: String,
        update: Value,
    },
    PermissionRequested {
        session_id: String,
        permission_id: String,
        title: String,
        tool_call: Value,
        options: Vec<PermissionChoice>,
    },
    PermissionResolved {
        session_id: String,
        permission_id: String,
        option_id: Option<String>,
    },
    TurnEnded {
        session_id: String,
        stop_reason: Option<String>,
        error: Option<String>,
    },
    /// Something to tell the user (launch failures, no response, reopen results, etc.)
    Notice {
        session_id: String,
        message: String,
    },
    /// Config options and usage (sent in full on every change; every 0.5 s while streaming)
    Info {
        session_id: String,
        info: Box<SessionInfo>,
    },
    /// The session was renamed to a title the agent set
    Renamed {
        session_id: String,
        title: String,
    },
    /// A turn hit a rate or usage limit with no fallback to move to: the session is sent its prompt again with the
    /// same key at `at` (ms). `at: None` when that is no longer planned (sent, cancelled, or given up)
    ResumeScheduled {
        session_id: String,
        at: Option<i64>,
    },
    /// Where the session works changed outside the usual actions (its worktree folder was removed, so it continues in
    /// the original repository)
    WorkspaceChanged {
        session: SessionRecord,
    },
}

/// How long a session stays in the trash before it is deleted at the next start
const TRASH_KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub struct EngineOptions {
    /// Config and profiles (each profile's own config directory lives under it)
    pub state_dir: PathBuf,
    /// Sessions: the database, worktrees, conversation folders and attachments. None: the same as state_dir.
    /// A development build keeps these apart so it never mixes its sessions with the installed app's
    pub data_dir: Option<PathBuf>,
    pub config: Config,
    pub secrets: Arc<dyn SecretStore>,
    /// Mark the session Stalled if nothing arrives for this long during a turn
    pub stall_after: Duration,
}

/// How the agent session is opened
enum Resume {
    New,
    /// session/load. Falls back to a new session when the agent has no record.
    /// `adopted` keeps the resent history as the transcript, and a failed load does not start a blank session.
    Load {
        session_id: String,
        adopted: bool,
    },
    /// session/fork. No fallback: a blank session would drop the conversation
    Fork(String),
}

/// A conversation the CLI already has, and Plyfold does not
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CliSession {
    pub acp_session_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
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

/// A permission request the user has not answered yet
struct Pending {
    /// JSON-RPC request ID
    request_id: Value,
    /// The option that allows it once (or the first that allows), if the agent offered one
    allow: Option<String>,
    /// The tool call's kind (edit, execute, fetch…)
    kind: Option<String>,
}

struct Live {
    client: AcpClient,
    acp_sid: Mutex<String>,
    /// permission_id → the request waiting for an answer
    permissions: Mutex<HashMap<String, Pending>>,
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
    /// The start of this turn's answer, to tell a rate or usage limit reported as a message (see hit_limit)
    turn_text: Mutex<String>,
    /// While Some, the whole answer is kept here too (the summary asked for when handing a session over)
    capture: Mutex<Option<String>>,
    /// Permission requests answered without asking: a side chat declines them all, an everyday chat allows looking things
    /// up (search, fetch, read) and declines the rest
    policy: Policy,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Policy {
    Ask,
    DeclineAll,
    LookUpOnly,
}

impl Policy {
    fn of(rec: &SessionRecord) -> Self {
        if rec.side_of.is_some() {
            Policy::DeclineAll
        } else if rec.chat {
            Policy::LookUpOnly
        } else {
            Policy::Ask
        }
    }
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
    /// Where sessions are kept (see EngineOptions::data_dir)
    data_dir: PathBuf,
    /// Settings per repository (worktree setup, permission rules)
    repos: repos::Repos,
    worktrees: Worktrees,
    live: Mutex<HashMap<String, Arc<Live>>>,
    /// Workspaces changing branch. A prompt reserves its turn under the same lock.
    checkouts: Mutex<HashSet<PathBuf>>,
    tx: broadcast::Sender<EngineEvent>,
    stall_after_ms: AtomicU64,
    perm_seq: AtomicU64,
    /// Per reviewed session: what was last reviewed, and a review waiting for the reviewer to finish its turn
    reviews: Mutex<HashMap<String, ReviewState>>,
    /// Send a prompt again when the limit it hit lifts (Settings → Sessions)
    resume_after_limit: AtomicBool,
    /// Per session: the prompt waiting for a limit to lift
    resumes: Mutex<HashMap<String, PendingResume>>,
    resume_seq: AtomicU64,
}

/// A prompt to send again when the limit it hit lifts
struct PendingResume {
    text: String,
    attachments: Vec<Attachment>,
    /// How many times this prompt has waited on a limit; past MAX_RESUMES Plyfold stops trying
    attempts: u32,
    /// When it is sent (ms); None while the resumed turn is under way
    at: Option<i64>,
    /// The current wait: a newer one, or a cancel, leaves an older timer with nothing to do
    token: u64,
}

/// Waits on a limit for one prompt before giving up
const MAX_RESUMES: u32 = 6;
/// After the reset time, so the provider has caught up
const RESUME_SLACK_MS: i64 = 30_000;
/// When the message does not say when the limit lifts
const RESUME_GUESS_MS: i64 = 30 * 60_000;
/// A limit per minute that does not say when it lifts
const RESUME_SHORT_MS: i64 = 90_000;

#[derive(Default)]
struct ReviewState {
    /// Hash of the diff last sent for review (the same diff is not reviewed twice)
    last: Option<u64>,
    /// The instruction behind the latest turn, shown to the reviewer
    instruction: Option<String>,
    /// A turn ended while the reviewer was still answering: review again when it is done
    pending: bool,
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
        let data_dir = opts.data_dir.clone().unwrap_or_else(|| opts.state_dir.clone());
        let store = Store::open(&data_dir.join("plyfold.db"))?;
        // Sessions that were running in the previous launch no longer have a process, so mark them Closed
        for s in store.list_sessions()? {
            // Reviewers are recreated as needed. Side conversations are kept across launches.
            if s.review && s.side_of.is_some() {
                if let Some(acp) = &s.acp_session_id {
                    store.dismiss_conversation(acp)?;
                }
                store.delete_session(&s.id)?;
                continue;
            }
            // Sessions in the trash for 30 days go for good; their worktrees stay, so no work is lost
            if s.trashed_at.is_some_and(|at| plyfold_store::now_ms() - at > TRASH_KEEP_MS) {
                store.delete_session(&s.id)?;
                continue;
            }
            if !matches!(s.status, SessionStatus::Closed | SessionStatus::Error) {
                store.set_status(&s.id, SessionStatus::Closed)?;
            }
        }
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                config: RwLock::new(opts.config),
                secrets: opts.secrets,
                worktrees: Worktrees::new(data_dir.join("worktrees")),
                repos: repos::Repos::new(&opts.state_dir),
                state_dir: opts.state_dir,
                data_dir,
                live: Mutex::new(HashMap::new()),
                checkouts: Mutex::new(HashSet::new()),
                tx: broadcast::channel(4096).0,
                stall_after_ms: AtomicU64::new(opts.stall_after.as_millis() as u64),
                perm_seq: AtomicU64::new(0),
                reviews: Mutex::new(HashMap::new()),
                resume_after_limit: AtomicBool::new(true),
                resumes: Mutex::new(HashMap::new()),
                resume_seq: AtomicU64::new(0),
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
        self.start_session_with_created(req, |_| {}).await
    }

    pub async fn start_session_with_created(&self, req: StartSession, created: impl FnOnce(&SessionRecord) + Send) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        let agent = inner.config.read().unwrap().profiles.get(&req.profile).map(|p| p.agent.clone()).unwrap_or_else(|| req.profile.clone());
        let rec = inner.store.create_session(NewSession { title: req.title, profile: req.profile.clone(), agent, ..Default::default() })?;
        inner.emit(EngineEvent::SessionCreated { session: rec.clone() });
        created(&rec);

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
        // SessionCreated went out before the workspace was set: send the record again with its repository and worktree
        inner.emit(EngineEvent::WorkspaceChanged { session: inner.store.get_session(&rec.id)? });
        if req.worktree
            && let Some(repo) = inner.store.get_session(&rec.id)?.repo_path
        {
            self.prepare_worktree(&rec.id, Path::new(&repo), &cwd).await;
        }
        self.launch(&rec.id, &req.profile, &cwd, Resume::New).await?;
        Ok(inner.store.get_session(&rec.id)?)
    }

    /// A new worktree gets the repository's untracked files it needs and runs its setup script, before the agent
    /// starts. Problems are reported in the conversation; the session starts anyway
    async fn prepare_worktree(&self, id: &str, repo: &Path, worktree: &Path) {
        let inner = &self.inner;
        let settings = inner.repos.get(&repo.display().to_string());
        if !settings.copy.is_empty() {
            let (done, problems) = repos::copy_files(repo, worktree, &settings.copy);
            if !done.is_empty() {
                inner.notice(id, plyfold_i18n::tr!("worktree にコピーしました: {}", "Copied into the worktree: {}", "已复制到 worktree：{}", done.join(", ")));
            }
            for p in problems {
                inner.notice(id, plyfold_i18n::tr!("コピーできませんでした: {p}", "Could not copy: {p}", "无法复制：{p}"));
            }
        }
        let script = settings.setup.trim().to_string();
        if script.is_empty() {
            return;
        }
        inner.notice(id, plyfold_i18n::tr!("準備スクリプトを実行しています", "Running the setup script", "正在运行准备脚本"));
        let log = inner.data_dir.join("setup-logs").join(format!("{id}.log"));
        let (wt, repo) = (worktree.to_path_buf(), repo.to_path_buf());
        let port = session_port(inner, id).ok().flatten();
        let run = tokio::task::spawn_blocking(move || repos::run_setup(&script, &wt, &repo, port, &log)).await;
        let note = match run {
            Ok(Ok(r)) if r.ok => {
                plyfold_i18n::tr!("準備スクリプトが終わりました（{} 秒）", "The setup script finished ({} s)", "准备脚本已完成（{} 秒）", r.elapsed.as_secs())
            }
            Ok(Ok(r)) if r.timed_out => plyfold_i18n::tr!(
                "準備スクリプトが 15 分で終わらなかったので止めました。最後の出力:\n{}",
                "Stopped the setup script after 15 minutes. Last output:\n{}",
                "准备脚本 15 分钟内未完成，已停止。最后的输出：\n{}",
                r.tail
            ),
            Ok(Ok(r)) => plyfold_i18n::tr!(
                "準備スクリプトが失敗しました。最後の出力:\n{}",
                "The setup script failed. Last output:\n{}",
                "准备脚本失败。最后的输出：\n{}",
                r.tail
            ),
            Ok(Err(e)) => plyfold_i18n::tr!("準備スクリプトを実行できません: {e}", "Cannot run the setup script: {e}", "无法运行准备脚本：{e}"),
            Err(e) => plyfold_i18n::tr!("準備スクリプトを実行できません: {e}", "Cannot run the setup script: {e}", "无法运行准备脚本：{e}"),
        };
        inner.notice(id, note);
    }

    /// Settings of a repository (empty ones when it has none)
    pub fn repo_settings(&self, repo: &str) -> repos::RepoSettings {
        self.inner.repos.get(repo)
    }

    pub fn set_repo_settings(&self, repo: &str, settings: repos::RepoSettings) -> Result<(), CoreError> {
        Ok(self.inner.repos.set(repo, settings)?)
    }

    /// Repositories Plyfold knows: the ones sessions worked in, and the ones with settings
    pub fn known_repos(&self) -> Result<Vec<String>, CoreError> {
        let mut all: std::collections::BTreeSet<String> = self.inner.repos.all().into_keys().collect();
        for s in self.inner.store.list_sessions()? {
            if !s.chat
                && s.side_of.is_none()
                && let Some(r) = s.repo_path
            {
                all.insert(r);
            }
        }
        Ok(all.into_iter().collect())
    }

    /// An everyday conversation: no repository, but a folder of its own (agents need one to work in), under the state
    /// directory. The agent may search and read the web; edits and commands are declined
    pub async fn start_chat(&self, profile: &str, title: &str) -> Result<SessionRecord, CoreError> {
        self.start_chat_with_created(profile, title, |_| {}).await
    }

    pub async fn start_chat_with_created(&self, profile: &str, title: &str, created: impl FnOnce(&SessionRecord) + Send) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        let agent = inner.config.read().unwrap().profiles.get(profile).map(|p| p.agent.clone()).unwrap_or_else(|| profile.to_string());
        let rec = inner.store.create_session(NewSession { title: title.to_string(), profile: profile.to_string(), agent, chat: true, ..Default::default() })?;
        let dir = self.chat_dir(&rec.id);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            inner.store.delete_session(&rec.id)?;
            return Err(CoreError::Io(e));
        }
        inner.store.set_workspace(&rec.id, Some(&dir.display().to_string()), None, None, None)?;
        let rec = inner.store.get_session(&rec.id)?;
        inner.emit(EngineEvent::SessionCreated { session: rec.clone() });
        created(&rec);
        self.launch(&rec.id, profile, &dir, Resume::New).await?;
        // A mode in which the agent asks before acting (so Plyfold's policy answers) or only reads, rather than one that
        // acts on its own (Claude Code's auto, for example)
        let info = self.session_info(&rec.id);
        match info.as_ref().and_then(chat_mode) {
            Some(mode) => {
                let _ = self.set_category(&rec.id, Category::Mode, &mode).await;
            }
            // The agent has modes, but none Plyfold knows to ask before acting: its own default may act without asking,
            // and then no request reaches Plyfold's policy
            None if info.is_some_and(|i| !i.modes.is_empty() || i.option(Category::Mode).is_some()) => {
                inner.notice(
                    &rec.id,
                    plyfold_i18n::tr!(
                        "このエージェントには、操作の前に確認するモードが見つかりませんでした。会話でも、エージェントが確認せずにファイルを編集したりコマンドを実行したりすることがあります",
                        "This agent has no mode Plyfold knows to ask before acting, so even in a conversation it may edit files or run commands without asking",
                        "未找到此代理在操作前确认的模式，因此即使在对话中，代理也可能不经确认就编辑文件或执行命令"
                    ),
                );
            }
            None => {}
        }
        Ok(inner.store.get_session(&rec.id)?)
    }

    fn chat_dir(&self, id: &str) -> PathBuf {
        self.inner.data_dir.join("chats").join(id)
    }

    /// Restart the agent for a stopped session. If supported, session/load restores the full context
    pub async fn reopen_session(&self, id: &str) -> Result<(), CoreError> {
        if self.is_running(id) {
            return Err(CoreError::AlreadyRunning(id.into()));
        }
        let rec = self.reconcile_workspace(id)?;
        let cwd = rec.worktree_path.clone().or(rec.repo_path.clone()).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        if rec.chat {
            std::fs::create_dir_all(&cwd)?;
        }
        let resume = match rec.acp_session_id {
            Some(session_id) => Resume::Load { session_id, adopted: false },
            None => Resume::New,
        };
        self.launch(id, &rec.profile, Path::new(&cwd), resume).await?;
        if rec.side_of.is_some()
            && let Some(mode) = self.session_info(id).and_then(|info| read_only_mode(&info))
        {
            let _ = self.set_category(id, Category::Mode, &mode).await;
        }
        Ok(())
    }

    /// A new session with the source conversation.
    /// `new_worktree` gives it its own worktree (uncommitted files stay in the source).
    /// The same workspace is refused while any agent is running there, so two agents never edit one directory.
    pub async fn fork_session(&self, id: &str, new_worktree: bool) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        let src = inner.store.get_session(id)?;
        let acp = src.acp_session_id.clone().ok_or_else(|| CoreError::NoConversation(id.into()))?;
        if src.status == SessionStatus::Starting {
            return Err(CoreError::Busy(id.into()));
        }
        if self.is_running(id) {
            let live = inner.live(id)?;
            if live.in_turn.load(Ordering::SeqCst) {
                return Err(CoreError::Busy(id.into()));
            }
        }
        let repo = src.repo_path.clone().ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        if !new_worktree {
            let dir = src.worktree_path.clone().unwrap_or_else(|| repo.clone());
            if workspace_in_use(inner, &dir) {
                return Err(CoreError::SharedWorkspace(id.into()));
            }
        }
        let t = src.title.clone();
        let title = plyfold_i18n::tr!("「{t}」の分岐", "Fork of {t}", "「{t}」的分叉");
        let rec = inner.store.create_session(NewSession { title, profile: src.profile.clone(), agent: src.agent.clone(), ..Default::default() })?;
        inner.store.copy_transcript(id, &rec.id)?;

        let cwd = if new_worktree {
            let at = src.worktree_path.as_deref().unwrap_or(repo.as_str());
            let base = plyfold_worktree::head(Path::new(at)).or(src.base_ref.clone());
            match inner.worktrees.create(Path::new(&repo), &rec.id, base.as_deref()) {
                Ok(wt) => {
                    inner.store.set_workspace(
                        &rec.id,
                        Some(&wt.repo.display().to_string()),
                        Some(&wt.path.display().to_string()),
                        Some(&wt.branch),
                        Some(&wt.base),
                    )?;
                    wt.path
                }
                Err(e) => {
                    inner.notice(&rec.id, plyfold_i18n::tr!("作業場所を用意できません: {e}", "Cannot prepare the workspace: {e}", "无法准备工作区：{e}"));
                    inner.set_status(&rec.id, SessionStatus::Error);
                    inner.emit(EngineEvent::SessionCreated { session: inner.store.get_session(&rec.id)? });
                    return Err(e.into());
                }
            }
        } else {
            let cwd = src.worktree_path.clone().unwrap_or_else(|| repo.clone());
            inner.store.set_workspace(&rec.id, Some(&repo), src.worktree_path.as_deref(), src.branch.as_deref(), src.base_ref.as_deref())?;
            PathBuf::from(cwd)
        };
        inner.emit(EngineEvent::SessionCreated { session: inner.store.get_session(&rec.id)? });
        self.launch(&rec.id, &src.profile, &cwd, Resume::Fork(acp)).await?;
        let note = if new_worktree {
            plyfold_i18n::tr!(
                "新しい worktree で分岐しました（未コミットの変更は含みません）",
                "Forked into a new worktree (uncommitted changes are not included)",
                "已在新 worktree 中分叉（不含未提交的更改）"
            )
        } else {
            plyfold_i18n::tr!("同じ作業場所で分岐しました", "Forked in this workspace", "已在同一工作区中分叉")
        };
        inner.notice(&rec.id, note);
        Ok(inner.store.get_session(&rec.id)?)
    }

    /// Hand the session's work over to another profile (another agent, or another key) in the same workspace.
    /// The session's agent is asked for a summary first when it can answer (skipped after HANDOVER_WAIT); then it is
    /// stopped, and a new session starts there and is sent the instructions so far, the summary and the diff, and asked
    /// to carry on. The old session keeps its record
    pub async fn hand_over(&self, id: &str, profile: &str) -> Result<SessionRecord, CoreError> {
        let r = self.hand_over_inner(id, profile).await;
        // The UI does not wait on this (the note can take minutes), so a failure is told on the session
        if let Err(e) = &r {
            self.inner
                .notice(id, plyfold_i18n::tr!("{profile} に引き継げませんでした: {e}", "Could not hand over to {profile}: {e}", "无法交给 {profile}：{e}"));
        }
        r
    }

    async fn hand_over_inner(&self, id: &str, profile: &str) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        let src = inner.store.get_session(id)?;
        if src.side_of.is_some() || src.chat {
            return Err(CoreError::NoWorkspace(id.into()));
        }
        if src.status == SessionStatus::Starting || inner.live(id).is_ok_and(|l| l.in_turn.load(Ordering::SeqCst)) {
            return Err(CoreError::Busy(id.into()));
        }
        let agent = {
            let config = inner.config.read().unwrap();
            if !config.profiles.contains_key(profile) && !config.agents.contains_key(profile) {
                return Err(ProfileError::UnknownTarget(profile.into()).into());
            }
            config.profiles.get(profile).map(|p| p.agent.clone()).unwrap_or_else(|| profile.to_string())
        };
        let repo = src.repo_path.clone().ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        let cwd = src.worktree_path.clone().unwrap_or_else(|| repo.clone());

        let summary = self.ask_summary(&src).await;
        for side in inner.store.list_sessions()?.into_iter().filter(|s| s.side_of.as_deref() == Some(id)) {
            self.close_side_chat(&side.id).await?;
        }
        self.close_session(id).await?;
        if workspace_in_use(inner, &cwd) {
            return Err(CoreError::SharedWorkspace(id.into()));
        }

        let rec = inner.store.create_session(NewSession {
            title: src.title.clone(),
            profile: profile.to_string(),
            agent,
            repo_path: Some(repo.clone()),
            worktree_path: src.worktree_path.clone(),
            branch: src.branch.clone(),
            base_ref: src.base_ref.clone(),
            ..Default::default()
        })?;
        if let Some(group) = &src.run_group {
            inner.store.set_run_group(&rec.id, Some(group))?;
        }
        inner.emit(EngineEvent::SessionCreated { session: inner.store.get_session(&rec.id)? });
        self.launch(&rec.id, profile, Path::new(&cwd), Resume::New).await?;
        let diff = self.diff(&rec.id).unwrap_or_default();
        let from = src.profile.clone();
        inner.notice(&rec.id, plyfold_i18n::tr!("{from} から引き継ぎました", "Taken over from {from}", "已从 {from} 接手"));
        inner.notice(id, plyfold_i18n::tr!("{profile} に引き継ぎました", "Handed over to {profile}", "已交给 {profile}"));
        self.prompt(&rec.id, &handover_prompt(&self.instructions_of(id), summary.as_deref(), &diff))?;
        Ok(inner.store.get_session(&rec.id)?)
    }

    /// The session's agent, asked to sum up its work for whoever continues. None when it has no conversation, cannot
    /// be started, or takes longer than HANDOVER_WAIT
    async fn ask_summary(&self, src: &SessionRecord) -> Option<String> {
        src.acp_session_id.as_ref()?;
        if !self.is_running(&src.id) {
            self.reopen_session(&src.id).await.ok()?;
        }
        let live = self.inner.live(&src.id).ok()?;
        let mut rx = self.subscribe();
        *live.capture.lock().unwrap() = Some(String::new());
        let ask = plyfold_i18n::tr!(
            "この作業を別のエージェントに引き継ぎます。ファイルは変えずに、引き継ぎのメモを書いてください: 何を頼まれたか、何をしたか、何が残っているか、気をつけること。",
            "This work is being handed over to another agent. Without changing any files, write a handover note: what was asked, what was done, what is left, and anything to watch out for.",
            "这项工作将交给另一个代理。请不要更改任何文件，写一份交接说明：被要求做什么、已完成什么、还剩什么、需要注意什么。"
        );
        let asked = self.prompt(&src.id, &ask).is_ok();
        let ended = asked
            && tokio::time::timeout(HANDOVER_WAIT, async {
                loop {
                    match rx.recv().await {
                        Ok(EngineEvent::TurnEnded { session_id, error, .. }) if session_id == src.id => return error.is_none(),
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => return false,
                    }
                }
            })
            .await
            .unwrap_or(false);
        let text = live.capture.lock().unwrap().take();
        if !ended {
            let _ = self.cancel(&src.id).await;
            return None;
        }
        text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    }

    /// What the user asked the session, oldest first (the last HANDOVER_INSTRUCTIONS, each cut short)
    fn instructions_of(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut after = None;
        while let Ok(batch) = self.inner.store.events(id, after, 5000) {
            let Some(last) = batch.last() else { break };
            after = Some(last.id);
            for e in batch.iter().filter(|e| e.kind == EventKind::FrameOut && e.payload.contains("\"session/prompt\"")) {
                let Ok(v) = serde_json::from_str::<Value>(&e.payload) else { continue };
                let text: String =
                    v["params"]["prompt"].as_array().map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("")).unwrap_or_default();
                let text = text.trim();
                if !text.is_empty() {
                    out.push(text.chars().take(2000).collect());
                }
            }
        }
        // The note asked for by hand_over is not one of the user's instructions
        out.retain(|t: &String| !t.contains(HANDOVER_MARK_JA) && !t.contains(HANDOVER_MARK_EN) && !t.contains(HANDOVER_MARK_ZH));
        let skip = out.len().saturating_sub(HANDOVER_INSTRUCTIONS);
        out.split_off(skip)
    }

    /// Open a side chat on a session: a read-only fork in the same workspace, for questions that should not enter the
    /// main conversation. Allowed while the main session is working (the fork starts from what the agent has saved so
    /// far). Its permission requests are declined, and a read-only mode is chosen when the agent has one
    pub async fn open_side_chat(&self, id: &str) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        let src = inner.store.get_session(id)?;
        if src.side_of.is_some() {
            return Err(CoreError::NoConversation(id.into()));
        }
        let acp = src.acp_session_id.clone().ok_or_else(|| CoreError::NoConversation(id.into()))?;
        if src.status == SessionStatus::Starting {
            return Err(CoreError::Busy(id.into()));
        }
        let repo = src.repo_path.clone().ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        let cwd = src.worktree_path.clone().unwrap_or_else(|| repo.clone());
        let title = plyfold_i18n::tr!("サイドチャット", "Side chat", "侧边对话");
        let rec = inner.store.create_session(NewSession {
            title,
            profile: src.profile.clone(),
            agent: src.agent.clone(),
            repo_path: Some(repo),
            worktree_path: src.worktree_path.clone(),
            branch: src.branch.clone(),
            base_ref: src.base_ref.clone(),
            side_of: Some(id.to_string()),
            chat: src.chat,
            review: false,
        })?;
        inner.emit(EngineEvent::SessionCreated { session: rec.clone() });
        if let Err(e) = self.launch(&rec.id, &src.profile, Path::new(&cwd), Resume::Fork(acp)).await {
            let _ = self.close_side_chat(&rec.id).await;
            return Err(e);
        }
        // Ask the agent itself not to edit too, where it has such a mode (Claude Code: plan, Codex: read-only, OpenCode: plan)
        if let Some(mode) = self.session_info(&rec.id).and_then(|info| read_only_mode(&info)) {
            let _ = self.set_category(&rec.id, Category::Mode, &mode).await;
        }
        Ok(inner.store.get_session(&rec.id)?)
    }

    /// Close a side chat: stop its agent and delete it. Its agent-side conversation is remembered so it is not offered
    /// as a CLI conversation to open
    pub async fn close_side_chat(&self, id: &str) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        if rec.side_of.is_none() {
            return Err(CoreError::NoConversation(id.into()));
        }
        self.close_session(id).await?;
        if let Some(acp) = &rec.acp_session_id {
            self.inner.store.dismiss_conversation(acp)?;
        }
        self.inner.store.delete_session(id)?;
        Ok(())
    }

    /// Conversations this CLI already has in `repo`, excluding ones Plyfold already recorded.
    /// The agent process used for the list is stopped before this returns.
    pub async fn list_cli_sessions(&self, profile: &str, repo: &Path) -> Result<Vec<CliSession>, CoreError> {
        let dir = plyfold_worktree::repo_root(repo).unwrap_or_else(|_| repo.to_path_buf());
        let inner = &self.inner;
        let resolved = inner.config.read().unwrap().resolve(profile, &inner.state_dir, &dir, inner.secrets.as_ref())?;
        let (client, mut rx) = AcpClient::connect(&resolved.spawn, None).await?;
        let client = Arc::new(client);
        let reader = {
            let client = client.clone();
            tokio::spawn(async move {
                while let Some(msg) = rx.recv().await {
                    match msg {
                        AgentMessage::PermissionRequest { request_id, .. } => {
                            let _ = client.respond_permission(request_id, None).await;
                        }
                        AgentMessage::OtherRequest { request_id, .. } => {
                            let _ = client.respond_unsupported(request_id).await;
                        }
                        AgentMessage::Closed => break,
                        AgentMessage::Update { .. } | AgentMessage::OtherNotification { .. } => {}
                    }
                }
            })
        };
        let listed = async {
            if !client.supports_list() {
                return Err(CoreError::ListUnsupported);
            }
            let mut known: HashSet<String> = inner.store.list_sessions()?.into_iter().filter_map(|s| s.acp_session_id).collect();
            known.extend(inner.store.dismissed_conversations()?);
            let mut sessions = Vec::new();
            for info in client.list_sessions(&dir).await? {
                let acp_session_id = info.session_id.0.to_string();
                if acp_session_id.is_empty() || known.contains(&acp_session_id) {
                    continue;
                }
                let title = info.title.filter(|t| !t.trim().is_empty());
                sessions.push(CliSession { acp_session_id, title, updated_at: info.updated_at });
            }
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.title.cmp(&b.title)));
            Ok(sessions)
        }
        .await;
        reader.abort();
        client.shutdown().await;
        match listed {
            Err(CoreError::Acp(AcpError::Rpc { code: AcpError::METHOD_NOT_FOUND, .. })) => Err(CoreError::ListUnsupported),
            other => other,
        }
    }

    /// Open a conversation the CLI already has, in a new worktree. Uncommitted files stay in `repo`.
    /// With `worktree`, the conversation continues in a worktree of its own; without it, or when `repo` is not a git
    /// repository, in the folder itself
    pub async fn adopt_session(&self, profile: &str, repo: &Path, acp_session_id: &str, title: &str, worktree: bool) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        if acp_session_id.is_empty() {
            return Err(CoreError::NoConversation(String::new()));
        }
        if inner.store.list_sessions()?.iter().any(|s| s.acp_session_id.as_deref() == Some(acp_session_id)) {
            return Err(CoreError::AlreadyInPlyfold);
        }
        let agent = inner.config.read().unwrap().profiles.get(profile).map(|p| p.agent.clone()).unwrap_or_else(|| profile.to_string());
        let title = if title.trim().is_empty() { plyfold_i18n::tr!("（無題）", "(untitled)", "（无标题）") } else { title.to_string() };
        let rec = inner.store.create_session(NewSession { title, profile: profile.to_string(), agent, ..Default::default() })?;
        inner.emit(EngineEvent::SessionCreated { session: rec.clone() });
        let in_git = plyfold_worktree::repo_root(repo).is_ok();
        let prepared = if worktree && in_git {
            inner.worktrees.create(repo, &rec.id, None).map_err(CoreError::from)
        } else {
            inner.store.set_workspace(&rec.id, Some(&repo.display().to_string()), None, None, None)?;
            inner.emit(EngineEvent::WorkspaceChanged { session: inner.store.get_session(&rec.id)? });
            self.launch(&rec.id, profile, repo, Resume::Load { session_id: acp_session_id.to_string(), adopted: true }).await?;
            return Ok(inner.store.get_session(&rec.id)?);
        };
        let cwd = match prepared {
            Ok(wt) => {
                inner.store.set_workspace(
                    &rec.id,
                    Some(&wt.repo.display().to_string()),
                    Some(&wt.path.display().to_string()),
                    Some(&wt.branch),
                    Some(&wt.base),
                )?;
                wt.path
            }
            Err(e) => {
                inner.notice(&rec.id, plyfold_i18n::tr!("作業場所を用意できません: {e}", "Cannot prepare the workspace: {e}", "无法准备工作区：{e}"));
                inner.set_status(&rec.id, SessionStatus::Error);
                return Err(e);
            }
        };
        inner.emit(EngineEvent::WorkspaceChanged { session: inner.store.get_session(&rec.id)? });
        self.launch(&rec.id, profile, &cwd, Resume::Load { session_id: acp_session_id.to_string(), adopted: true }).await?;
        Ok(inner.store.get_session(&rec.id)?)
    }

    async fn launch(&self, id: &str, profile: &str, cwd: &Path, resume: Resume) -> Result<(), CoreError> {
        let inner = self.inner.clone();
        inner.set_status(id, SessionStatus::Starting);
        let result: Result<(), CoreError> = async {
            let mut resolved = inner.config.read().unwrap().resolve(profile, &inner.state_dir, cwd, inner.secrets.as_ref())?;
            // A port of its own for dev servers, so sessions side by side do not fight over 3000 (most dev servers
            // read PORT; PLYFOLD_PORT is there for scripts that want to know it)
            if let Some(port) = session_port(&inner, id)? {
                resolved.spawn.env_set.push(("PORT".into(), port.to_string()));
                resolved.spawn.env_set.push(("PLYFOLD_PORT".into(), port.to_string()));
            }
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
                turn_text: Mutex::new(String::new()),
                capture: Mutex::new(None),
                policy: inner.store.get_session(id).map(|r| Policy::of(&r)).unwrap_or(Policy::Ask),
            });
            // Start receiving first so the history resent by session/load is captured
            tokio::spawn(pump(inner.clone(), id.to_string(), live.clone(), rx));

            let (mcp_servers, skipped) = plyfold_profile::prepare_mcp(&resolved.mcp, live.client.supports_mcp_http(), live.client.supports_mcp_sse());
            for message in skipped {
                inner.notice(id, message);
            }

            let opened: Result<String, CoreError> = async {
                if let Resume::Fork(old) = &resume {
                    if !live.client.supports_fork() {
                        return Err(CoreError::ForkUnsupported);
                    }
                    // Anything the agent sends before the response is a resend, not new output. The transcript already
                    // has the conversation, copied from the source session's log
                    let _ = inner.store.append_event(id, EventKind::Note, REPLAY_BEGIN);
                    live.replaying.store(true, Ordering::SeqCst);
                    let forked = live.client.fork_session(old, cwd, mcp_servers.clone()).await;
                    if let Ok((_, barrier)) = &forked {
                        live.wait_processed(*barrier).await;
                    }
                    live.replaying.store(false, Ordering::SeqCst);
                    let _ = inner.store.append_event(id, EventKind::Note, REPLAY_END);
                    let resp = match forked {
                        Ok((resp, _)) => resp,
                        Err(AcpError::Rpc { code: AcpError::METHOD_NOT_FOUND, .. }) => return Err(CoreError::ForkUnsupported),
                        Err(e) => return Err(e.into()),
                    };
                    let sid = resp["sessionId"].as_str().unwrap_or_default().to_string();
                    if sid.is_empty() {
                        return Err(CoreError::ForkUnsupported);
                    }
                    live.info.lock().unwrap().apply_session_response(&resp);
                    inner.store.set_acp_session_id(id, &sid)?;
                    if live.info.lock().unwrap().current_mode.is_none()
                        && let Some(mode) = &resolved.default_mode
                    {
                        live.client.set_mode(&sid, mode).await?;
                        live.info.lock().unwrap().current_mode = Some(mode.clone());
                    }
                    return Ok(sid);
                }
                // Why reopening failed (reported when continuing in a new session)
                let mut fallback = None;
                if let Resume::Load { session_id: old, adopted } = &resume {
                    if live.client.supports_load_session() {
                        // Mark the resent history in the event log so it is not rebuilt as a second copy of the conversation
                        let _ = inner.store.append_event(id, EventKind::Note, REPLAY_BEGIN);
                        live.replaying.store(true, Ordering::SeqCst);
                        let loaded = live.client.load_session(old, cwd, mcp_servers.clone()).await;
                        if let Ok((_, barrier)) = &loaded {
                            live.wait_processed(*barrier).await;
                        }
                        live.replaying.store(false, Ordering::SeqCst);
                        let _ = inner.store.append_event(id, EventKind::Note, REPLAY_END);
                        match loaded {
                            Ok((resp, _)) => {
                                live.info.lock().unwrap().apply_session_response(&resp);
                                inner.store.set_acp_session_id(id, old)?;
                                if *adopted {
                                    // Plyfold has no earlier copy, so lift the resend out of the load request where the transcript skips it
                                    inner.store.keep_resent_history(id, REPLAY_BEGIN, REPLAY_END)?;
                                    let in_worktree = inner.store.get_session(id).ok().is_some_and(|r| r.worktree_path.is_some());
                                    inner.notice(
                                        id,
                                        if in_worktree {
                                            plyfold_i18n::tr!(
                                                "この CLI にあった会話を、新しい worktree で開きました（未コミットの変更は含みません）",
                                                "Opened a conversation this CLI already had, in a new worktree (uncommitted changes are not included)",
                                                "已在新 worktree 中打开此 CLI 已有的对话（不含未提交的更改）"
                                            )
                                        } else {
                                            plyfold_i18n::tr!(
                                                "この CLI にあった会話を、このフォルダのまま開きました",
                                                "Opened a conversation this CLI already had, in this folder",
                                                "已在此文件夹中打开此 CLI 已有的对话"
                                            )
                                        },
                                    );
                                } else {
                                    inner.notice(id, plyfold_i18n::tr!("session/load で開き直しました（履歴はエージェントから再送されます）", "Reopened with session/load (the agent resends the history)", "已通过 session/load 重新打开（历史记录由代理重新发送）"));
                                }
                                return Ok(old.clone());
                            }
                            // Adopting a missing conversation must not silently start a blank one
                            Err(AcpError::Rpc { code: -32002, .. }) if *adopted => return Err(CoreError::ConversationMissing),
                            Err(e) if *adopted => {
                                return Err(match background_session(&e.to_string()) {
                                    Some(id) => CoreError::ConversationRunning(id),
                                    None => e.into(),
                                });
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
                    } else if *adopted {
                        return Err(CoreError::CannotResume);
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
                        let r = live.client.new_session(cwd, mcp_servers).await?;
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
        // A new prompt replaces one waiting for a limit to lift
        self.drop_resume(id);
        self.prompt_tried(id, text, attachments, Vec::new())
    }

    /// `tried`: profiles this prompt already hit a limit with (a fallback chain never goes round in a circle)
    fn prompt_tried(&self, id: &str, text: &str, attachments: &[Attachment], tried: Vec<String>) -> Result<(), CoreError> {
        let inner = self.inner.clone();
        let live = inner.live(id)?;
        // For agents without image support, write images to the state dir and pass them as links
        let blocks = attach::prompt_blocks(text, attachments, live.client.supports_images(), &inner.data_dir.join("attachments"))
            .map_err(|e| CoreError::Attachment(e.to_string()))?;
        let checkouts = inner.checkouts.lock().unwrap();
        if !checkouts.is_empty() {
            let record = inner.store.get_session(id)?;
            if checkouts.iter().any(|root| session_in_workspace(&record, root)) {
                return Err(CoreError::Busy(id.into()));
            }
        }
        if live.in_turn.swap(true, Ordering::SeqCst) {
            return Err(CoreError::Busy(id.into()));
        }
        live.touch();
        live.stalled.store(false, Ordering::SeqCst);
        *live.clock.lock().unwrap() = Some(TurnClock::new());
        live.info.lock().unwrap().live = Some(LiveTurn::default());
        live.turn_text.lock().unwrap().clear();
        inner.set_status(id, SessionStatus::Working);
        drop(checkouts);
        let id = id.to_string();
        let (text, attachments) = (text.to_string(), attachments.to_vec());
        tokio::spawn(async move {
            let r = live.client.prompt_blocks(&live.sid(), blocks).await;
            // The turn is still on while its last notifications are handled (a stalled turn that gets its answer
            // shows as working again, and the end is reported only after everything it sent)
            if let Ok(turn) = &r {
                live.wait_processed(turn.barrier).await;
            }
            live.in_turn.store(false, Ordering::SeqCst);
            live.permissions.lock().unwrap().clear();
            let limit_text = match &r {
                Ok(_) => live.turn_text.lock().unwrap().clone(),
                Err(e) => e.to_string(),
            };
            let limited = hit_limit(&limit_text, r.is_ok());
            let ended = r
                .as_ref()
                .is_ok_and(|t| serde_json::to_value(t.response.stop_reason).ok().and_then(|v| v.as_str().map(str::to_string)).as_deref() == Some("end_turn"));
            match r {
                Ok(turn) => {
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
            if live.closing.load(Ordering::SeqCst) {
                return;
            }
            inner.set_status(&id, SessionStatus::Idle);
            let engine = Engine { inner };
            if limited {
                if !engine.continue_with_fallback(&id, &text, &attachments, tried).await {
                    engine.schedule_resume(&id, &text, &attachments, &limit_text);
                }
            } else {
                // The prompt got through, or failed for another reason: nothing waits on a limit any more
                engine.inner.resumes.lock().unwrap().remove(&id);
                if ended {
                    engine.after_turn(&id, &text).await;
                }
            }
        });
        Ok(())
    }

    /// After a turn that ended normally: a reviewed session sends its diff to the reviewer; a reviewer that finished
    /// sends the review that waited on it
    async fn after_turn(&self, id: &str, text: &str) {
        let Ok(rec) = self.inner.store.get_session(id) else { return };
        let (main, instruction) = if rec.review {
            let Some(main) = rec.side_of.clone() else { return };
            let waiting = self.inner.reviews.lock().unwrap().get_mut(&main).is_some_and(|s| std::mem::take(&mut s.pending));
            if !waiting {
                return;
            }
            (main, None)
        } else if rec.side_of.is_none() && !rec.chat && rec.reviewer.is_some() {
            (rec.id.clone(), Some(text))
        } else {
            return;
        };
        if let Err(e) = self.review(&main, instruction, false).await {
            self.inner.notice(&main, plyfold_i18n::tr!("レビューを始められませんでした: {e}", "Could not start the review: {e}", "无法开始审查：{e}"));
        }
    }

    /// Choose the profile that reviews this session after each turn (None: no review). Turning it off, or changing
    /// it, closes the reviewer that was running
    pub async fn set_reviewer(&self, id: &str, profile: Option<&str>) -> Result<SessionRecord, CoreError> {
        let inner = &self.inner;
        let rec = inner.store.get_session(id)?;
        if rec.side_of.is_some() || rec.chat {
            return Err(CoreError::NoWorkspace(id.into()));
        }
        if let Some(p) = profile {
            let config = inner.config.read().unwrap();
            if !config.profiles.contains_key(p) && !config.agents.contains_key(p) {
                return Err(ProfileError::UnknownTarget(p.into()).into());
            }
        }
        if rec.reviewer.as_deref() != profile {
            for r in self.reviewers_of(id)? {
                self.close_side_chat(&r.id).await?;
            }
            inner.reviews.lock().unwrap().remove(id);
        }
        inner.store.set_reviewer(id, profile)?;
        let rec = inner.store.get_session(id)?;
        inner.emit(EngineEvent::WorkspaceChanged { session: rec.clone() });
        Ok(rec)
    }

    fn reviewers_of(&self, id: &str) -> Result<Vec<SessionRecord>, CoreError> {
        Ok(self.inner.store.list_sessions()?.into_iter().filter(|s| s.review && s.side_of.as_deref() == Some(id)).collect())
    }

    /// Send the session's diff to its reviewer (started when needed, read-only). `instruction` is what the latest turn
    /// was asked to do. Without `force`, a diff already reviewed is not sent again. Returns the reviewer's id, or None
    /// when there was nothing to review
    pub async fn review(&self, id: &str, instruction: Option<&str>, force: bool) -> Result<Option<String>, CoreError> {
        let inner = &self.inner;
        let rec = inner.store.get_session(id)?;
        let Some(profile) = rec.reviewer.clone() else { return Ok(None) };
        let diff = self.diff(id)?;
        if diff.patch.trim().is_empty() {
            return Ok(None);
        }
        let hash = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            diff.patch.hash(&mut h);
            h.finish()
        };
        let instruction = {
            let mut reviews = inner.reviews.lock().unwrap();
            let state = reviews.entry(id.to_string()).or_default();
            if let Some(i) = instruction {
                state.instruction = Some(i.to_string());
            }
            if !force && state.last == Some(hash) {
                return Ok(None);
            }
            state.instruction.clone()
        };

        let reviewer = match self.reviewers_of(id)?.into_iter().next() {
            Some(r) if self.is_running(&r.id) => r.id,
            Some(r) => {
                self.reopen_session(&r.id).await?;
                r.id
            }
            None => self.start_reviewer(&rec, &profile).await?,
        };
        let live = inner.live(&reviewer)?;
        if live.in_turn.load(Ordering::SeqCst) {
            inner.reviews.lock().unwrap().entry(id.to_string()).or_default().pending = true;
            return Ok(Some(reviewer));
        }
        self.prompt(&reviewer, &review_prompt(&diff, instruction.as_deref()))?;
        inner.reviews.lock().unwrap().entry(id.to_string()).or_default().last = Some(hash);
        Ok(Some(reviewer))
    }

    async fn start_reviewer(&self, rec: &SessionRecord, profile: &str) -> Result<String, CoreError> {
        let inner = &self.inner;
        let cwd = rec.worktree_path.clone().or(rec.repo_path.clone()).ok_or_else(|| CoreError::NoWorkspace(rec.id.clone()))?;
        let agent = inner.config.read().unwrap().profiles.get(profile).map(|p| p.agent.clone()).unwrap_or_else(|| profile.to_string());
        let r = inner.store.create_session(NewSession {
            title: plyfold_i18n::tr!("レビュー", "Review", "审查"),
            profile: profile.to_string(),
            agent,
            repo_path: rec.repo_path.clone(),
            worktree_path: rec.worktree_path.clone(),
            branch: rec.branch.clone(),
            base_ref: rec.base_ref.clone(),
            side_of: Some(rec.id.clone()),
            chat: false,
            review: true,
        })?;
        inner.emit(EngineEvent::SessionCreated { session: r.clone() });
        if let Err(e) = self.launch(&r.id, profile, Path::new(&cwd), Resume::New).await {
            let _ = self.close_side_chat(&r.id).await;
            return Err(e);
        }
        // Ask the agent itself not to edit too, where it has such a mode; the policy declines edits either way
        if let Some(mode) = self.session_info(&r.id).and_then(|info| read_only_mode(&info)) {
            let _ = self.set_category(&r.id, Category::Mode, &mode).await;
        }
        Ok(r.id)
    }

    /// After a turn hit a rate or usage limit: when the session's profile names a fallback (another key of the same
    /// agent) not tried for this prompt yet, reopen the session with it and send the prompt again.
    /// An isolated profile keeps conversations in its own directory, so the conversation's files are copied over first
    /// True when the session moved to the fallback and the prompt went out again
    async fn continue_with_fallback(&self, id: &str, text: &str, attachments: &[Attachment], mut tried: Vec<String>) -> bool {
        let inner = &self.inner;
        let Ok(rec) = inner.store.get_session(id) else { return false };
        tried.push(rec.profile.clone());
        let (to, from_dir, to_dir) = {
            let config = inner.config.read().unwrap();
            let Some(to) = config.fallback_for(&rec.profile).filter(|p| !tried.contains(p)) else { return false };
            let dirs = (config.data_dir_of(&rec.profile, &inner.state_dir), config.data_dir_of(&to, &inner.state_dir));
            (to, dirs.0, dirs.1)
        };
        inner.notice(
            id,
            plyfold_i18n::tr!(
                "{} のキーが上限に達したので、{to} に切り替えて同じ指示を送り直します",
                "{}'s key hit its limit, so the session continues with {to} and sends the prompt again",
                "{} 的密钥已达到上限，因此切换到 {to} 并重新发送同一指令",
                rec.profile
            ),
        );
        let result: Result<(), CoreError> = async {
            self.close_session(id).await?;
            if let Some(acp) = &rec.acp_session_id {
                match (&from_dir, &to_dir) {
                    (Some(from), Some(to_dir)) => {
                        copy_conversation(from, to_dir, acp)?;
                    }
                    (None, None) => {}
                    // One side uses the usual config, which Plyfold does not write to
                    _ => inner.notice(
                        id,
                        plyfold_i18n::tr!(
                            "片方のプロファイルが通常の設定を使うため、会話のファイルを写せません。エージェントが会話を開けないときは、新しい会話で続けます",
                            "One of the profiles uses the usual config, so the conversation's files cannot be copied; if the agent cannot open the conversation, it continues in a new one",
                            "其中一个配置使用常规设置，因此无法复制对话文件；如果代理无法打开该对话，将在新对话中继续"
                        ),
                    ),
                }
            }
            inner.store.set_profile(id, &to)?;
            inner.emit(EngineEvent::WorkspaceChanged { session: inner.store.get_session(id)? });
            self.reopen_session(id).await?;
            self.prompt_tried(id, text, attachments, tried)
        }
        .await;
        match result {
            Ok(()) => true,
            Err(e) => {
                inner.notice(id, plyfold_i18n::tr!("{to} に切り替えられませんでした: {e}", "Could not continue with {to}: {e}", "无法切换到 {to}：{e}"));
                false
            }
        }
    }

    /// After a limit with no fallback: send the prompt again with the same key when the limit lifts (the time the
    /// message gives, else a guess), unless that is turned off. Side sessions are not resumed
    fn schedule_resume(&self, id: &str, text: &str, attachments: &[Attachment], limit_text: &str) {
        let inner = &self.inner;
        if !inner.resume_after_limit.load(Ordering::SeqCst) || inner.store.get_session(id).map_or(true, |r| r.side_of.is_some()) {
            return;
        }
        let now = jiff::Zoned::now();
        let now_ms = now.timestamp().as_millisecond();
        let found = limits::reset_at(limit_text, &now);
        let at = match found {
            Some(ts) => ts.as_millisecond().max(now_ms) + RESUME_SLACK_MS,
            None if limit_text.to_lowercase().contains("minute") => now_ms + RESUME_SHORT_MS,
            None => now_ms + RESUME_GUESS_MS,
        };
        let token = inner.resume_seq.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut map = inner.resumes.lock().unwrap();
            let entry = map.entry(id.to_string()).or_insert_with(|| PendingResume {
                text: text.to_string(),
                attachments: attachments.to_vec(),
                attempts: 0,
                at: None,
                token: 0,
            });
            entry.attempts += 1;
            if entry.attempts > MAX_RESUMES {
                map.remove(id);
                drop(map);
                inner.notice(
                    id,
                    plyfold_i18n::tr!(
                        "同じ指示が利用上限に {MAX_RESUMES} 回続けて当たったので、自動での再開をやめました",
                        "The same prompt hit a limit {MAX_RESUMES} times in a row, so it is no longer resumed by itself",
                        "同一指令连续 {MAX_RESUMES} 次遇到用量上限，已停止自动继续"
                    ),
                );
                return;
            }
            entry.at = Some(at);
            entry.token = token;
        }
        let when = local_time(at);
        inner.notice(
            id,
            if found.is_some() {
                plyfold_i18n::tr!(
                    "利用上限に達しました。{when} に上限が解けるので、同じキーで自動で再開します",
                    "Hit a usage limit. It lifts at {when}, when the session resumes with the same key",
                    "已达到用量上限。上限将于 {when} 解除，届时会用同一密钥自动继续"
                )
            } else {
                plyfold_i18n::tr!(
                    "利用上限に達しました。解ける時刻がわからないので、{when} に同じキーで試します",
                    "Hit a usage limit. When it lifts is not known, so the session tries again with the same key at {when}",
                    "已达到用量上限。不知道何时解除，将于 {when} 用同一密钥重试"
                )
            },
        );
        inner.emit(EngineEvent::ResumeScheduled { session_id: id.into(), at: Some(at) });
        let engine = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            loop {
                let left = at - plyfold_store::now_ms();
                if left <= 0 {
                    break;
                }
                // Wake at least once a minute: a timer stands still while the machine sleeps, the clock does not
                tokio::time::sleep(Duration::from_millis(left.min(60_000) as u64)).await;
                if !engine.resume_waits(&id, token) {
                    return;
                }
            }
            engine.fire_resume(&id, token).await;
        });
    }

    fn resume_waits(&self, id: &str, token: u64) -> bool {
        self.inner.resumes.lock().unwrap().get(id).is_some_and(|e| e.token == token && e.at.is_some())
    }

    /// Send the waiting prompt again (reopening the session if it was stopped)
    async fn fire_resume(&self, id: &str, token: u64) {
        let inner = &self.inner;
        let (text, attachments) = {
            let mut map = inner.resumes.lock().unwrap();
            let Some(e) = map.get_mut(id).filter(|e| e.token == token && e.at.is_some()) else { return };
            e.at = None;
            (e.text.clone(), e.attachments.clone())
        };
        inner.emit(EngineEvent::ResumeScheduled { session_id: id.into(), at: None });
        let result: Result<(), CoreError> = async {
            if !self.is_running(id) {
                self.reopen_session(id).await?;
            }
            if inner.live(id)?.in_turn.load(Ordering::SeqCst) {
                return Err(CoreError::Busy(id.into()));
            }
            inner.notice(id, plyfold_i18n::tr!("利用上限が解けたので、再開します", "The limit has lifted; resuming", "上限已解除，正在继续"));
            let again = plyfold_i18n::tr!(
                "利用上限が解けたので、上限で止まった指示を続けてください。止まったときの指示:\n{text}",
                "The usage limit has lifted. Carry on with the instruction that stopped at the limit:\n{text}",
                "用量上限已解除。请继续执行因上限而停止的指令：\n{text}"
            );
            self.prompt_tried(id, &again, &attachments, Vec::new())
        }
        .await;
        if let Err(e) = result {
            inner.resumes.lock().unwrap().remove(id);
            inner.notice(id, plyfold_i18n::tr!("自動で再開できませんでした: {e}", "Could not resume by itself: {e}", "无法自动继续：{e}"));
        }
    }

    /// Send a prompt waiting on a limit now. False when none is waiting
    pub async fn resume_now(&self, id: &str) -> bool {
        let token = self.inner.resumes.lock().unwrap().get(id).filter(|e| e.at.is_some()).map(|e| e.token);
        match token {
            Some(t) => {
                self.fire_resume(id, t).await;
                true
            }
            None => false,
        }
    }

    /// Drop a prompt waiting on a limit, at the user's request. False when none was waiting
    pub fn cancel_resume(&self, id: &str) -> bool {
        let dropped = self.drop_resume(id);
        if dropped {
            self.inner.notice(id, plyfold_i18n::tr!("自動の再開を取り消しました", "The automatic resume was cancelled", "已取消自动继续"));
        }
        dropped
    }

    fn drop_resume(&self, id: &str) -> bool {
        let waiting = self.inner.resumes.lock().unwrap().remove(id).is_some_and(|e| e.at.is_some());
        if waiting {
            self.inner.emit(EngineEvent::ResumeScheduled { session_id: id.into(), at: None });
        }
        waiting
    }

    /// Sessions whose prompt waits on a limit, and when it goes out (ms)
    pub fn scheduled_resumes(&self) -> Vec<(String, i64)> {
        self.inner.resumes.lock().unwrap().iter().filter_map(|(id, e)| e.at.map(|at| (id.clone(), at))).collect()
    }

    /// Settings → Sessions. Turning it off drops the prompts already waiting
    pub fn set_resume_after_limit(&self, on: bool) {
        self.inner.resume_after_limit.store(on, Ordering::SeqCst);
        if !on {
            let ids: Vec<String> = self.inner.resumes.lock().unwrap().keys().cloned().collect();
            for id in ids {
                self.drop_resume(&id);
            }
        }
    }

    /// Cancel. Pending permission requests are answered with "cancelled" (per the ACP spec)
    pub async fn cancel(&self, id: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let pending: Vec<(String, Pending)> = live.permissions.lock().unwrap().drain().collect();
        for (pid, p) in pending {
            live.client.respond_permission(p.request_id, None).await?;
            self.inner.emit(EngineEvent::PermissionResolved { session_id: id.into(), permission_id: pid, option_id: None });
        }
        live.client.cancel(&live.sid()).await?;
        Ok(())
    }

    /// An option_id of None is treated as a cancel
    pub async fn respond_permission(&self, id: &str, permission_id: &str, option_id: Option<&str>) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let request_id = live.permissions.lock().unwrap().remove(permission_id).ok_or_else(|| CoreError::UnknownPermission(permission_id.into()))?.request_id;
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
    /// A conversation's or side chat's mode option stays as Plyfold set it (see set_by_category)
    pub async fn set_config_option(&self, id: &str, config_id: &str, value: &str) -> Result<(), CoreError> {
        let is_mode = self.inner.live(id)?.info.lock().unwrap().option(Category::Mode).is_some_and(|o| o.id == config_id);
        if is_mode && Policy::of(&self.inner.store.get_session(id)?) != Policy::Ask {
            return Err(CoreError::ModeLocked);
        }
        self.apply_config_option(id, config_id, value).await
    }

    async fn apply_config_option(&self, id: &str, config_id: &str, value: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let opts = live.client.set_config_option(&live.sid(), config_id, value).await?;
        live.info.lock().unwrap().set_config(&opts);
        emit_info(&self.inner, id, &live);
        Ok(())
    }

    /// Change model / effort / mode without caring how each agent names them.
    /// For mode, fall back to the legacy session/set_mode when configOptions lacks it
    /// A conversation or a side chat keeps the mode Plyfold chose for it: one that acts without asking (bypass, auto)
    /// would let it edit files and run commands that Plyfold otherwise declines
    pub async fn set_by_category(&self, id: &str, category: Category, value: &str) -> Result<(), CoreError> {
        if category == Category::Mode && Policy::of(&self.inner.store.get_session(id)?) != Policy::Ask {
            return Err(CoreError::ModeLocked);
        }
        self.set_category(id, category, value).await?;
        if category == Category::Mode {
            self.allow_pending_for_mode(id, value).await?;
        }
        Ok(())
    }

    /// After switching to a mode that would not have asked, answer the requests still waiting as that mode would:
    /// everything for bypass, file edits for accept-edits. The agent keeps asking for the request it already sent
    async fn allow_pending_for_mode(&self, id: &str, mode: &str) -> Result<(), CoreError> {
        let Some(covers) = mode_allows(mode) else { return Ok(()) };
        let live = self.inner.live(id)?;
        let allowed: Vec<(String, Pending)> = {
            let mut pending = live.permissions.lock().unwrap();
            let ids: Vec<String> = pending.iter().filter(|(_, p)| p.allow.is_some() && covers(p.kind.as_deref())).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|k| pending.remove(&k).map(|p| (k, p))).collect()
        };
        if allowed.is_empty() {
            return Ok(());
        }
        for (pid, p) in &allowed {
            live.client.respond_permission(p.request_id.clone(), p.allow.as_deref()).await?;
            self.inner.emit(EngineEvent::PermissionResolved { session_id: id.into(), permission_id: pid.clone(), option_id: p.allow.clone() });
        }
        live.touch();
        self.inner.notice(
            id,
            plyfold_i18n::tr!(
                "モードを切り替えたので、確認待ちだった {} 件を許可しました",
                "Allowed {} waiting permission request(s), since the new mode does not ask",
                "已切换模式，因此允许了 {} 个等待中的权限请求",
                allowed.len()
            ),
        );
        if live.in_turn.load(Ordering::SeqCst) && live.permissions.lock().unwrap().is_empty() {
            self.inner.set_status(id, SessionStatus::Working);
        }
        Ok(())
    }

    async fn set_category(&self, id: &str, category: Category, value: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let config_id = live.info.lock().unwrap().option(category).map(|o| o.id.clone());
        match (config_id, category) {
            (Some(cid), _) => self.apply_config_option(id, &cid, value).await,
            (None, Category::Mode) => self.apply_mode(id, value).await,
            (None, c) => Err(CoreError::NoSuchOption(c)),
        }
    }

    /// The legacy session/set_mode. Locked for conversations and side chats, like set_by_category
    pub async fn set_mode(&self, id: &str, mode_id: &str) -> Result<(), CoreError> {
        if Policy::of(&self.inner.store.get_session(id)?) != Policy::Ask {
            return Err(CoreError::ModeLocked);
        }
        self.apply_mode(id, mode_id).await
    }

    async fn apply_mode(&self, id: &str, mode_id: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        live.client.set_mode(&live.sid(), mode_id).await?;
        live.info.lock().unwrap().current_mode = Some(mode_id.to_string());
        emit_info(&self.inner, id, &live);
        Ok(())
    }

    /// Stop the agent (the record and worktree are kept)
    pub async fn close_session(&self, id: &str) -> Result<(), CoreError> {
        // A stopped session does not start again by itself
        self.drop_resume(id);
        let live = self.inner.live.lock().unwrap().remove(id);
        if let Some(live) = live {
            live.closing.store(true, Ordering::SeqCst);
            live.client.shutdown().await;
        }
        self.inner.set_status(id, SessionStatus::Closed);
        Ok(())
    }

    /// Move to the trash: the agent stops and the session leaves the list, but its record, conversation and worktree
    /// stay, so restore_session puts it back as it was
    pub async fn trash_session(&self, id: &str) -> Result<SessionRecord, CoreError> {
        for side in self.inner.store.list_sessions()?.into_iter().filter(|s| s.side_of.as_deref() == Some(id)) {
            if side.review {
                self.close_side_chat(&side.id).await?;
            } else {
                self.close_session(&side.id).await?;
            }
        }
        self.close_session(id).await?;
        self.inner.store.set_trashed(id, Some(plyfold_store::now_ms()))?;
        let rec = self.inner.store.get_session(id)?;
        self.inner.emit(EngineEvent::WorkspaceChanged { session: rec.clone() });
        Ok(rec)
    }

    /// Tie sessions started from one prompt into a comparison (None takes a session out of it)
    pub fn set_run_group(&self, id: &str, group: Option<&str>) -> Result<SessionRecord, CoreError> {
        self.inner.store.set_run_group(id, group)?;
        let rec = self.inner.store.get_session(id)?;
        self.inner.emit(EngineEvent::WorkspaceChanged { session: rec.clone() });
        Ok(rec)
    }

    /// Take a session out of the trash (it stays stopped until it is opened)
    pub fn restore_session(&self, id: &str) -> Result<SessionRecord, CoreError> {
        self.inner.store.set_trashed(id, None)?;
        let rec = self.inner.store.get_session(id)?;
        self.inner.emit(EngineEvent::WorkspaceChanged { session: rec.clone() });
        Ok(rec)
    }

    /// Delete every session in the trash for good (with `remove_worktree`, their worktrees and branches too).
    /// Returns the ids deleted
    pub async fn empty_trash(&self, remove_worktree: bool) -> Result<Vec<String>, CoreError> {
        let trashed: Vec<String> = self.inner.store.list_sessions()?.into_iter().filter(|s| s.trashed_at.is_some()).map(|s| s.id).collect();
        for id in &trashed {
            self.delete_session(id, remove_worktree).await?;
        }
        Ok(trashed)
    }

    /// Delete the session and its record. With `remove_worktree`, also delete the worktree and branch (work is lost),
    /// unless another session still uses that worktree: then only the record goes, and the others are told it was kept
    pub async fn delete_session(&self, id: &str, remove_worktree: bool) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        for side in self.inner.store.list_sessions()?.into_iter().filter(|s| s.side_of.as_deref() == Some(id)) {
            self.close_side_chat(&side.id).await?;
        }
        self.close_session(id).await?;
        if remove_worktree && let Some(wt) = worktree_of(&rec) {
            let others = rec.worktree_path.as_deref().map(|path| sessions_sharing_worktree(&self.inner, id, path)).transpose()?.unwrap_or_default();
            if others.is_empty() {
                self.inner.worktrees.remove(&wt, true)?;
            } else {
                let note = plyfold_i18n::tr!(
                    "同じ worktree のセッションを消しました。このセッションが使っているので、worktree と枝は残してあります",
                    "A session that shared this worktree was deleted. The worktree and branch were kept, because this session still uses them",
                    "已删除一个共用此 worktree 的会话。此会话仍在使用，因此保留了 worktree 和分支"
                );
                for other in &others {
                    self.inner.notice(other, note.clone());
                }
            }
        }
        // A conversation's folder is Plyfold's own; it goes with the session
        if rec.chat {
            let _ = std::fs::remove_dir_all(self.chat_dir(id));
        }
        self.inner.store.delete_session(id)?;
        Ok(())
    }

    /// Worktree diff (from the commit it was created at to the current working tree)
    /// The changes since the base commit for a worktree session. A session working in the repository itself shows its
    /// uncommitted changes (against HEAD); committing, merging and discarding stay with worktree sessions
    pub fn diff(&self, id: &str) -> Result<Diff, CoreError> {
        let rec = self.reconcile_workspace(id)?;
        // A conversation and a side chat have no repository: their folder is not one, and git would walk up from it to
        // whatever repository contains it
        if rec.chat || rec.side_of.is_some() {
            return Err(CoreError::NoWorkspace(id.into()));
        }
        let wt = match worktree_of(&rec) {
            Some(wt) => wt,
            None => {
                let dir = PathBuf::from(rec.repo_path.as_deref().ok_or_else(|| CoreError::NoWorkspace(id.into()))?);
                let head = plyfold_worktree::head(&dir).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
                Worktree { repo: dir.clone(), path: dir, branch: String::new(), base: head }
            }
        };
        Ok(plyfold_worktree::diff(&wt)?)
    }

    /// The session's record, after checking that its worktree still exists. One removed outside Plyfold (by hand, or by
    /// an agent running `git worktree remove`) would leave every Git action failing on a missing folder; the session
    /// then continues in the original repository, as after a cleanup, and the UI is told
    fn reconcile_workspace(&self, id: &str) -> Result<SessionRecord, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let Some(wt) = rec.worktree_path.as_deref() else { return Ok(rec) };
        if Path::new(wt).exists() {
            return Ok(rec);
        }
        // Removed through git (git worktree remove, or Plyfold's cleanup): continue in the repository. A folder that
        // vanished while git still lists it (deleted from inside, by the agent for one) is not taken as permission to
        // work in the repository itself
        if let Some(repo) = rec.repo_path.as_deref()
            && plyfold_worktree::is_registered(Path::new(repo), Path::new(wt))
        {
            return Err(plyfold_worktree::WorktreeError::Op(plyfold_i18n::tr!(
                "worktree {wt} のフォルダがありませんが、git にはまだ登録されています。元のリポジトリで続けるなら、リポジトリで git worktree prune を実行してから開き直してください",
                "The folder of the worktree {wt} is gone, but git still lists it. To continue in the original repository, run git worktree prune in it and open the session again",
                "worktree {wt} 的文件夹不存在，但 git 中仍有登记。若要在原仓库中继续，请在仓库中运行 git worktree prune 后重新打开会话"
            ))
            .into());
        }
        self.inner.store.set_workspace(id, rec.repo_path.as_deref(), None, None, None)?;
        self.inner.notice(
            id,
            plyfold_i18n::tr!(
                "worktree {wt} が見つからないので、元のリポジトリで続けます",
                "The worktree {wt} is gone, so this session continues in the original repository",
                "找不到 worktree {wt}，此会话将在原仓库中继续"
            ),
        );
        let rec = self.inner.store.get_session(id)?;
        self.inner.emit(EngineEvent::WorkspaceChanged { session: rec.clone() });
        Ok(rec)
    }

    fn idle_worktree(&self, id: &str) -> Result<Worktree, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        if matches!(rec.status, SessionStatus::Working | SessionStatus::AwaitingPermission | SessionStatus::Stalled | SessionStatus::Starting) {
            return Err(CoreError::Busy(id.into()));
        }
        worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))
    }

    /// The session's working directory, verifying a managed worktree before running Git in it.
    fn git_workspace(&self, id: &str) -> Result<(SessionRecord, PathBuf), CoreError> {
        let rec = self.reconcile_workspace(id)?;
        // As with diff: a conversation's folder is not a repository, and git would find the one around it
        if rec.chat || rec.side_of.is_some() {
            return Err(CoreError::NoWorkspace(id.into()));
        }
        if let Some(wt) = worktree_of(&rec) {
            plyfold_worktree::verify(&wt)?;
            return Ok((rec, wt.path));
        }
        let dir = PathBuf::from(rec.repo_path.as_deref().ok_or_else(|| CoreError::NoWorkspace(id.into()))?);
        Ok((rec, dir))
    }

    /// The working directory and its comparison branch.
    fn git_dir(&self, id: &str) -> Result<(PathBuf, Option<String>), CoreError> {
        let (rec, dir) = self.git_workspace(id)?;
        let base = match worktree_of(&rec) {
            Some(wt) => plyfold_worktree::ops::status(&wt).ok().and_then(|s| s.target),
            None => plyfold_worktree::remote::remote_default(&dir),
        };
        Ok((dir, base))
    }

    pub fn git_history(&self, id: &str) -> Result<plyfold_worktree::history::History, CoreError> {
        let (_, dir) = self.git_workspace(id)?;
        Ok(plyfold_worktree::history::history(&dir)?)
    }

    pub fn git_checkout(&self, id: &str, target: plyfold_worktree::history::Checkout) -> Result<(), CoreError> {
        let (_, dir) = self.git_workspace(id)?;
        let root = plyfold_worktree::repo_root(&dir)?;
        let root = root.canonicalize().unwrap_or(root);
        {
            let mut checkouts = self.inner.checkouts.lock().unwrap();
            if checkouts.contains(&root)
                || self.inner.store.list_sessions()?.iter().any(|record| {
                    matches!(record.status, SessionStatus::Starting | SessionStatus::Working | SessionStatus::AwaitingPermission | SessionStatus::Stalled)
                        && session_in_workspace(record, &root)
                })
            {
                return Err(CoreError::Busy(id.into()));
            }
            checkouts.insert(root.clone());
        }
        let result = plyfold_worktree::history::checkout(&dir, target);
        self.inner.checkouts.lock().unwrap().remove(&root);
        result.map_err(Into::into)
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
        let rec = self.reconcile_workspace(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        Ok(plyfold_worktree::ops::status(&wt)?)
    }

    /// Commit every change in the working tree (not allowed mid-turn)
    pub fn commit(&self, id: &str, message: &str) -> Result<String, CoreError> {
        let wt = self.idle_worktree(id)?;
        let hash = plyfold_worktree::ops::commit(&wt, message)?;
        self.inner
            .notice(id, plyfold_i18n::tr!("コミットしました: {hash} {}", "Committed: {hash} {}", "已提交：{hash} {}", message.lines().next().unwrap_or("")));
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

    /// Cleanup after merging: stop the agent and delete the worktree and branch. The record stays; reopening runs in the original repository.
    /// Returns whether the worktree was actually removed. It is kept, and this session stays on it, while another session still uses it
    pub async fn cleanup_worktree(&self, id: &str) -> Result<bool, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        let others = rec.worktree_path.as_deref().map(|path| sessions_sharing_worktree(&self.inner, id, path)).transpose()?.unwrap_or_default();
        self.close_session(id).await?;
        if !others.is_empty() {
            self.inner.notice(
                id,
                plyfold_i18n::tr!(
                    "別のセッションが同じ worktree を使っているので、worktree と枝は残しました",
                    "Kept the worktree and branch, because another session still uses them",
                    "另一个会话仍在使用同一 worktree，因此保留了 worktree 和分支"
                ),
            );
            return Ok(false);
        }
        self.inner.worktrees.remove(&wt, true)?;
        self.inner.store.set_workspace(id, rec.repo_path.as_deref(), None, None, None)?;
        self.inner
            .notice(id, plyfold_i18n::tr!("worktree と枝 {} を片付けました", "Removed the worktree and branch {}", "已清理 worktree 和分支 {}", wt.branch));
        Ok(true)
    }

    /// Change the no-response timeout (takes effect from the next watchdog check)
    pub fn set_stall_after(&self, d: Duration) {
        self.inner.stall_after_ms.store(d.as_millis() as u64, Ordering::SeqCst);
    }

    /// Reset the working tree to the base commit. Refused while another session uses the same worktree, so its files are not wiped
    pub fn discard(&self, id: &str) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        if let Some(path) = rec.worktree_path.as_deref()
            && !sessions_sharing_worktree(&self.inner, id, path)?.is_empty()
        {
            return Err(CoreError::SharedWorktree);
        }
        let wt = self.idle_worktree(id)?;
        plyfold_worktree::ops::discard(&wt)?;
        self.inner.notice(
            id,
            plyfold_i18n::tr!(
                "変更を破棄して、{} に戻しました",
                "Discarded the changes and reset to {}",
                "已放弃更改，并恢复到 {}",
                &wt.base[..wt.base.len().min(7)]
            ),
        );
        Ok(())
    }
}

/// True when a running session already uses this directory
/// Ports handed to sessions, clear of the usual defaults (3000, 5173, 8000, 8080)
const PORTS: std::ops::RangeInclusive<u16> = 3101..=3999;

/// The session's port: the one it was given, or a new one no other session has and nothing listens on. None for
/// conversations and side chats, which run no dev servers
fn session_port(inner: &Inner, id: &str) -> Result<Option<u16>, CoreError> {
    let rec = inner.store.get_session(id)?;
    if rec.chat || rec.side_of.is_some() {
        return Ok(None);
    }
    if let Some(p) = rec.port {
        return Ok(Some(p));
    }
    let taken: HashSet<u16> = inner.store.list_sessions()?.into_iter().filter_map(|s| s.port).collect();
    let span = (*PORTS.end() - *PORTS.start() + 1) as usize;
    // Start from a spot the id picks, so sessions made together do not all probe the same ports
    let start = id.bytes().fold(0usize, |h, b| h.wrapping_mul(31).wrapping_add(b as usize)) % span;
    let free =
        (0..span).map(|i| *PORTS.start() + ((start + i) % span) as u16).find(|p| !taken.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok());
    if let Some(p) = free {
        inner.store.set_port(id, p)?;
    }
    Ok(free)
}

/// The option that allows a request this once. Never the one that allows it from now on: an answer Plyfold gives on
/// the user's behalf must not outlast the request
fn allow_once(v: &Value) -> Option<String> {
    v["options"].as_array()?.iter().find(|o| o["kind"] == "allow_once")?["optionId"].as_str().map(str::to_string)
}

/// Tools an everyday chat may use whatever kind they are labelled with (Claude Code's names): loading a skill, the
/// task list, and helper agents, whose own tool calls come back through this same policy
const CHAT_TOOLS: [&str; 3] = ["Skill", "TodoWrite", "Task"];

/// The tool's own name, where the agent gives it (Claude Code: toolCall.name, or _meta.claudeCode.toolName)
fn tool_name(v: &Value) -> Option<&str> {
    let call = &v["toolCall"];
    call["name"].as_str().or_else(|| call["_meta"]["claudeCode"]["toolName"].as_str())
}

/// The kind a request is treated as: "execute" when it carries a command, whatever the agent labelled it
fn effective_kind(v: &Value) -> Option<&str> {
    let raw = &v["toolCall"]["rawInput"];
    if raw.get("command").or_else(|| raw.get("cmd")).is_some_and(|c| !c.is_null()) {
        return Some("execute");
    }
    v["toolCall"]["kind"].as_str()
}

/// The paths a request is about (toolCall.locations)
fn locations(v: &Value) -> Vec<PathBuf> {
    v["toolCall"]["locations"].as_array().map(|a| a.iter().filter_map(|l| l["path"].as_str()).map(PathBuf::from).collect()).unwrap_or_default()
}

/// A path with `.` and `..` resolved, through links where it exists
fn resolved(p: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    // An existing parent may itself be a link
    match (out.parent().and_then(|d| std::fs::canonicalize(d).ok()), out.file_name()) {
        (Some(d), Some(f)) => d.join(f),
        _ => out,
    }
}

/// Whether there are paths and each is inside one of the roots
fn inside(paths: &[PathBuf], roots: &[PathBuf]) -> bool {
    let roots: Vec<PathBuf> = roots.iter().map(|r| resolved(r)).collect();
    !paths.is_empty() && paths.iter().all(|p| p.is_absolute() && roots.iter().any(|r| resolved(p).starts_with(r)))
}

fn self_chat_dir(inner: &Inner, id: &str) -> PathBuf {
    inner.data_dir.join("chats").join(id)
}

/// Which waiting requests a mode would not have asked about: all of them for the modes that never ask
/// (Claude Code's bypassPermissions, Codex's full-access, Gemini CLI's yolo), file edits for accept-edits modes
fn mode_allows(mode: &str) -> Option<fn(Option<&str>) -> bool> {
    match mode {
        "bypassPermissions" | "full-access" | "yolo" => Some(|_| true),
        "acceptEdits" | "autoEdit" | "auto_edit" => Some(|kind| matches!(kind, Some("edit" | "delete" | "move"))),
        _ => None,
    }
}

/// The mode for an everyday conversation: read-only where the agent has one (Codex), else one that asks before acting
/// (Claude Code's default), else planning (OpenCode)
fn chat_mode(info: &SessionInfo) -> Option<String> {
    const PREFERRED: [&str; 4] = ["read-only", "read_only", "default", "plan"];
    let ids: Vec<&str> = match info.option(Category::Mode) {
        Some(o) => o.choices.iter().map(|c| c.value.as_str()).collect(),
        None => info.modes.iter().map(|c| c.value.as_str()).collect(),
    };
    PREFERRED.iter().find(|m| ids.contains(m)).map(|m| m.to_string())
}

/// The mode in which the agent does not edit, if it has one
fn read_only_mode(info: &SessionInfo) -> Option<String> {
    const READ_ONLY: [&str; 3] = ["plan", "read-only", "read_only"];
    let ids: Vec<&str> = match info.option(Category::Mode) {
        Some(o) => o.choices.iter().map(|c| c.value.as_str()).collect(),
        None => info.modes.iter().map(|c| c.value.as_str()).collect(),
    };
    READ_ONLY.iter().find(|m| ids.contains(m)).map(|m| m.to_string())
}

fn workspace_in_use(inner: &Inner, dir: &str) -> bool {
    let running: Vec<String> = inner.live.lock().unwrap().keys().cloned().collect();
    // Side chats are read-only, so they never count as another agent editing the directory
    running.into_iter().any(|other| {
        inner.store.get_session(&other).ok().filter(|r| r.side_of.is_none()).and_then(|r| r.worktree_path.or(r.repo_path)).is_some_and(|path| path == dir)
    })
}

/// Other sessions whose worktree is this directory. A store error is returned rather than treated as "nobody",
/// which would otherwise delete a worktree that is still in use
fn sessions_sharing_worktree(inner: &Inner, id: &str, worktree_path: &str) -> Result<Vec<String>, CoreError> {
    Ok(inner
        .store
        .list_sessions()?
        .into_iter()
        .filter(|s| s.id != id && s.side_of.is_none() && s.worktree_path.as_deref() == Some(worktree_path))
        .map(|s| s.id)
        .collect())
}

fn worktree_of(rec: &SessionRecord) -> Option<Worktree> {
    Some(Worktree {
        repo: PathBuf::from(rec.repo_path.as_ref()?),
        path: PathBuf::from(rec.worktree_path.as_ref()?),
        branch: rec.branch.clone()?,
        base: rec.base_ref.clone()?,
    })
}

fn session_in_workspace(rec: &SessionRecord, root: &Path) -> bool {
    if rec.chat {
        return false;
    }
    let Some(dir) = rec.worktree_path.as_deref().or(rec.repo_path.as_deref()) else { return false };
    let Ok(canonical) = Path::new(dir).canonicalize() else { return false };
    canonical == root
        || (canonical.starts_with(root)
            && plyfold_worktree::repo_root(Path::new(dir)).ok().and_then(|top| top.canonicalize().ok()).is_some_and(|top| top == root))
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
                if update["sessionUpdate"] == "agent_message_chunk"
                    && let Some(t) = text
                    && !live.replaying.load(Ordering::SeqCst)
                {
                    let mut kept = live.turn_text.lock().unwrap();
                    if kept.len() < 4096 {
                        kept.push_str(t);
                    }
                    if let Some(c) = live.capture.lock().unwrap().as_mut()
                        && c.len() < HANDOVER_SUMMARY_MAX
                    {
                        c.push_str(t);
                    }
                }
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
            AgentMessage::PermissionRequest { request_id, request } if live.policy != Policy::Ask => {
                live.touch();
                let v = serde_json::to_value(&*request).unwrap_or(Value::Null);
                let option = |prefix: &str| {
                    v["options"]
                        .as_array()
                        .and_then(|a| a.iter().find(|o| o["kind"].as_str().is_some_and(|k| k.starts_with(prefix))))
                        .and_then(|o| o["optionId"].as_str())
                        .map(str::to_string)
                };
                let title = v["toolCall"]["title"].as_str().unwrap_or_default().to_string();
                // An everyday chat works like a chat on the web: it may search and fetch from the web, think, load
                // skills, keep a task list, ask helper agents, and read, search and write files inside its own folder.
                // It runs no commands and reaches nothing else on the disk. The kind is the agent's own label, so a
                // request that carries a command counts as one whatever it is labelled, and paths are checked
                let chat_dir = [self_chat_dir(inner, &id)];
                let looks_up = live.policy == Policy::LookUpOnly
                    && match effective_kind(&v) {
                        Some("fetch" | "think") => true,
                        Some("read" | "search" | "edit" | "delete" | "move") => inside(&locations(&v), &chat_dir),
                        _ => CHAT_TOOLS.contains(&tool_name(&v).unwrap_or_default()),
                    };
                if let (true, Some(once)) = (looks_up, allow_once(&v)) {
                    let _ = live.client.respond_permission(request_id, Some(&once)).await;
                } else {
                    // Decline once rather than cancel, so the agent carries on and answers without the change
                    let _ = live.client.respond_permission(request_id, option("reject").as_deref()).await;
                    let note = if live.policy == Policy::DeclineAll {
                        plyfold_i18n::tr!(
                            "サイドチャットは読み取りだけなので、断りました: {title}",
                            "Declined, because a side chat only reads: {title}",
                            "侧边对话只能读取，因此已拒绝：{title}"
                        )
                    } else {
                        plyfold_i18n::tr!(
                            "会話ではコマンドの実行と、会話のフォルダの外のファイルは使わないので、断りました: {title}",
                            "Declined, because a conversation runs no commands and uses no files outside its folder: {title}",
                            "对话中不执行命令，也不使用对话文件夹之外的文件，因此已拒绝：{title}"
                        )
                    };
                    inner.notice(&id, note);
                }
            }
            AgentMessage::PermissionRequest { request_id, request } => {
                live.touch();
                let pid = format!("perm-{}", inner.perm_seq.fetch_add(1, Ordering::SeqCst));
                let v = serde_json::to_value(&*request).unwrap_or(Value::Null);
                let allow = v["options"].as_array().and_then(|a| {
                    let kind = |k: &str| a.iter().find(|o| o["kind"] == k);
                    kind("allow_once")
                        .or_else(|| a.iter().find(|o| o["kind"].as_str().is_some_and(|k| k.starts_with("allow"))))
                        .and_then(|o| o["optionId"].as_str())
                        .map(str::to_string)
                });
                let kind = v["toolCall"]["kind"].as_str().map(str::to_string);
                // A kind the repository always allows is answered here, once, without showing the request: reads and
                // edits only inside the repository or its worktree, and a request carrying a command only when commands
                // are allowed (the kind is the agent's own label)
                if let Ok(rec) = inner.store.get_session(&id)
                    && let Some(repo) = rec.repo_path.as_deref()
                    && let Some(once) = allow_once(&v)
                {
                    let kind = effective_kind(&v);
                    let roots: Vec<PathBuf> = [rec.worktree_path.as_deref(), Some(repo)].into_iter().flatten().map(PathBuf::from).collect();
                    let within = || inside(&locations(&v), &roots);
                    let rule = inner.repos.get(repo);
                    let ok = rule.allows(kind)
                        && match kind {
                            Some("read" | "search" | "edit" | "delete" | "move") => within(),
                            _ => true,
                        };
                    if ok {
                        let _ = live.client.respond_permission(request_id, Some(&once)).await;
                        return;
                    }
                }
                live.permissions.lock().unwrap().insert(pid.clone(), Pending { request_id, allow, kind });
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
                    title: v["toolCall"]["title"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| plyfold_i18n::tr!("（タイトルなし）", "(untitled)", "（无标题）")),
                    tool_call: v["toolCall"].clone(),
                    options,
                });
            }
            AgentMessage::OtherRequest { request_id, method, .. } => {
                let _ = live.client.respond_unsupported(request_id).await;
                inner.notice(
                    &id,
                    plyfold_i18n::tr!("未対応のリクエスト {method} を断りました", "Declined the unsupported request {method}", "已拒绝不支持的请求 {method}"),
                );
            }
            AgentMessage::OtherNotification { .. } => {}
            AgentMessage::Closed => {
                inner.live.lock().unwrap().remove(&id);
                if !live.closing.load(Ordering::SeqCst) {
                    let tail = live.client.connection().stderr_tail();
                    let mut msg = plyfold_i18n::tr!("エージェントのプロセスが終了しました", "The agent process exited", "代理进程已退出");
                    if !tail.is_empty() {
                        msg += &plyfold_i18n::tr!(
                            "\nstderr の最後:\n{}",
                            "\nLast stderr output:\n{}",
                            "\nstderr 的最后几行：\n{}",
                            tail.iter().rev().take(20).rev().cloned().collect::<Vec<_>>().join("\n")
                        );
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
            inner.notice(
                &id,
                plyfold_i18n::tr!(
                    "{} 秒間、エージェントから何も届いていません",
                    "Nothing has arrived from the agent for {} seconds",
                    "已有 {} 秒没有收到代理的任何消息",
                    idle.as_secs()
                ),
            );
        }
    }
}

fn emit_info(inner: &Inner, id: &str, live: &Live) {
    let info = live.info.lock().unwrap().clone();
    inner.emit(EngineEvent::Info { session_id: id.into(), info: Box::new(info) });
}

/// Whether a turn ended on a rate or usage limit (of the key, not a fault in the work). `answer` is the turn's own
/// A time as this machine shows it, for notes ("11/21 15:00")
fn local_time(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map(|ts| ts.to_zoned(jiff::tz::TimeZone::system()).strftime("%m/%d %H:%M").to_string()).unwrap_or_default()
}

/// text: agents report some limits as a short message rather than an error, so only a short one counts
fn hit_limit(text: &str, answer: bool) -> bool {
    let t = text.trim().to_lowercase();
    const SIGNS: [&str; 9] = [
        "rate limit",
        "rate_limit",
        "usage limit",
        "quota",
        "credit balance",
        "insufficient_quota",
        "resource_exhausted",
        "too many requests",
        "out of credits",
    ];
    let sign = SIGNS.iter().any(|s| t.contains(s)) || t.contains("429");
    if !answer {
        return sign;
    }
    // A short answer that is the agent passing on an API error, or a plan's "limit reached … resets …" message
    // (an answer that merely talks about rate limits must not switch keys)
    t.chars().count() <= 600
        && ((t.starts_with("api error") && sign) || t.contains("usage limit reached") || (t.contains("limit reached") && t.contains("reset")))
}

/// The longest diff sent to a reviewer (it reads files itself for the rest)
const REVIEW_DIFF_MAX: usize = 120_000;

/// What a reviewer is asked: the instruction behind the turn, the files changed and the diff, and the shape of the answer
fn review_prompt(diff: &Diff, instruction: Option<&str>) -> String {
    let files = diff.files.iter().map(|f| format!("- {} (+{} -{})", f.path, f.added, f.removed)).collect::<Vec<_>>().join("\n");
    let mut patch = diff.patch.as_str();
    let cut = patch.len() > REVIEW_DIFF_MAX;
    if cut {
        let mut end = REVIEW_DIFF_MAX;
        while !patch.is_char_boundary(end) {
            end -= 1;
        }
        patch = &patch[..end];
    }
    let instruction = instruction.map(str::trim).filter(|i| !i.is_empty()).unwrap_or("—");
    let mut text = plyfold_i18n::tr!(
        "別のエージェントがこの作業フォルダで行った変更をレビューしてください。ファイルの編集や、何かを変えるコマンドの実行はしないでください（ファイルを読むのはかまいません）。\n\nそのエージェントが受けた最後の指示:\n{instruction}\n\n変更のあったファイル:\n{files}\n\nベースとの差分:\n~~~~diff\n{patch}\n~~~~",
        "Review the changes another agent made in this working folder. Do not edit files or run commands that change anything (reading files is fine).\n\nThe last instruction that agent was given:\n{instruction}\n\nFiles changed:\n{files}\n\nDiff against the base:\n~~~~diff\n{patch}\n~~~~",
        "请审查另一个代理在此工作文件夹中所做的更改。不要编辑文件，也不要运行会更改任何内容的命令（可以读取文件）。\n\n该代理收到的最后一条指令：\n{instruction}\n\n有更改的文件：\n{files}\n\n与基准的差异：\n~~~~diff\n{patch}\n~~~~"
    );
    if cut {
        text += &plyfold_i18n::tr!(
            "\n\n（差分が長いので途中で切りました。残りはファイルを読んで確かめてください）",
            "\n\n(The diff is long and was cut here; read the files for the rest)",
            "\n\n（差异过长，已在此截断；其余部分请直接读取文件）"
        );
    }
    text += &plyfold_i18n::tr!(
        "\n\n問題を重いものから順に、1 件ずつ「パス:行 — 問題 — 直し方」の形で挙げてください。この会話の前のレビューで挙げたものは、まだ直っていないときだけ挙げます。問題がなければ「指摘なし」とだけ答えてください。",
        "\n\nList the problems, most severe first, one per line as `path:line — problem — fix`. Mention a problem from an earlier review in this conversation only if it is still not fixed. If nothing is wrong, answer only \"No findings\".",
        "\n\n请按严重程度从高到低逐条列出问题，每条一行，格式为「路径:行 — 问题 — 修复方法」。本对话中之前审查已提出的问题，仅在仍未修复时再列出。如果没有问题，只回答「没有发现问题」。"
    );
    text
}

/// How long the old agent may take to write its handover note
const HANDOVER_WAIT: Duration = Duration::from_secs(180);
const HANDOVER_SUMMARY_MAX: usize = 20_000;
const HANDOVER_INSTRUCTIONS: usize = 10;
/// The longest diff passed on (the new agent reads the files for the rest)
const HANDOVER_DIFF_MAX: usize = 120_000;
/// Words from the note request, to keep it out of the instructions passed on
const HANDOVER_MARK_JA: &str = "引き継ぎのメモを書いてください";
const HANDOVER_MARK_EN: &str = "write a handover note";
const HANDOVER_MARK_ZH: &str = "写一份交接说明";

/// What the new agent is sent: the instructions so far, the old agent's note, and the diff
fn handover_prompt(instructions: &[String], summary: Option<&str>, diff: &Diff) -> String {
    let asked = if instructions.is_empty() {
        "—".to_string()
    } else {
        instructions.iter().map(|i| format!("- {}", i.replace('\n', "\n  "))).collect::<Vec<_>>().join("\n")
    };
    let note = summary.unwrap_or("—");
    let files = if diff.files.is_empty() {
        "—".to_string()
    } else {
        diff.files.iter().map(|f| format!("- {} (+{} -{})", f.path, f.added, f.removed)).collect::<Vec<_>>().join("\n")
    };
    let mut patch = diff.patch.as_str();
    let cut = patch.len() > HANDOVER_DIFF_MAX;
    if cut {
        let mut end = HANDOVER_DIFF_MAX;
        while !patch.is_char_boundary(end) {
            end -= 1;
        }
        patch = &patch[..end];
    }
    let mut text = plyfold_i18n::tr!(
        "別のエージェントがこの作業フォルダで進めていた作業を引き継いでください。\n\nこれまでに受けた指示（古い順）:\n{asked}\n\n前のエージェントの引き継ぎメモ:\n{note}\n\n変更のあったファイル:\n{files}\n\nベースとの差分:\n~~~~diff\n{patch}\n~~~~",
        "Take over the work another agent was doing in this working folder.\n\nThe instructions it was given (oldest first):\n{asked}\n\nIts handover note:\n{note}\n\nFiles changed:\n{files}\n\nDiff against the base:\n~~~~diff\n{patch}\n~~~~",
        "请接手另一个代理在此工作文件夹中进行的工作。\n\n它收到的指令（从旧到新）：\n{asked}\n\n它的交接说明：\n{note}\n\n有更改的文件：\n{files}\n\n与基准的差异：\n~~~~diff\n{patch}\n~~~~"
    );
    if cut {
        text += &plyfold_i18n::tr!(
            "\n\n（差分が長いので途中で切りました。残りはファイルを読んで確かめてください）",
            "\n\n(The diff is long and was cut here; read the files for the rest)",
            "\n\n（差异过长，已在此截断；其余部分请直接读取文件）"
        );
    }
    text += &plyfold_i18n::tr!(
        "\n\nまずファイルの今の状態を確かめ、残っている作業を続けてください。残りがなければ、そう伝えてください。",
        "\n\nFirst check the files as they are now, then carry on with what is left. If nothing is left, say so.",
        "\n\n请先确认文件的当前状态，然后继续完成剩余的工作。如果没有剩余工作，请直接说明。"
    );
    text
}

/// Copy a conversation's files (those named after its id) between two profiles' data directories, at the same
/// relative paths. Links are not followed and nothing outside `from` is read
fn copy_conversation(from: &Path, to: &Path, acp_session_id: &str) -> std::io::Result<usize> {
    fn walk(dir: &Path, depth: usize, found: &mut Vec<PathBuf>, id: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() && depth < 6 {
                walk(&path, depth + 1, found, id);
            } else if kind.is_file() && entry.file_name().to_string_lossy().contains(id) {
                found.push(path);
            }
        }
    }
    // An id short enough to match unrelated names would copy the wrong files
    if acp_session_id.len() < 8 || acp_session_id.contains(['/', '\\']) {
        return Ok(0);
    }
    let mut found = Vec::new();
    walk(from, 0, &mut found, acp_session_id);
    for src in &found {
        let rel = src.strip_prefix(from).map_err(std::io::Error::other)?;
        let dest = to.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, &dest)?;
    }
    Ok(found.len())
}

fn finish_turn(inner: &Inner, id: &str, live: &Live, usage: &Value) {
    let Some(clock) = live.clock.lock().unwrap().take() else { return };
    live.info.lock().unwrap().finish_turn(clock.finish(usage));
    emit_info(inner, id, live);
}

#[cfg(test)]
mod limit_tests {
    use super::*;

    #[test]
    fn a_limit_is_told_from_an_answer_about_limits() {
        assert!(hit_limit(r#"API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}"#, true));
        assert!(hit_limit("Claude AI usage limit reached|1767225600", true));
        assert!(hit_limit("5-hour limit reached ∙ resets 3pm", true));
        assert!(hit_limit("Credit balance is too low", false));
        assert!(!hit_limit("I added a rate limit to the login route, so a client gets 429 after 10 tries.", true));
        assert!(!hit_limit(&format!("API Error: 429 rate_limit_error {}", "x".repeat(700)), true));
        assert!(!hit_limit("connection reset by peer", false));
    }

    #[test]
    fn a_conversation_is_copied_by_its_id_without_following_links() {
        let base = std::env::temp_dir().join(format!("plyfold-copy-conv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (from, to) = (base.join("a"), base.join("b"));
        let sid = "0f6c1d2e-aaaa-bbbb-cccc-1234567890ab";
        std::fs::create_dir_all(from.join("projects/-w-repo")).unwrap();
        std::fs::write(from.join(format!("projects/-w-repo/{sid}.jsonl")), "conv").unwrap();
        std::fs::write(from.join("projects/-w-repo/other.jsonl"), "other").unwrap();
        assert_eq!(copy_conversation(&from, &to, sid).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(to.join(format!("projects/-w-repo/{sid}.jsonl"))).unwrap(), "conv");
        assert!(!to.join("projects/-w-repo/other.jsonl").exists());
        assert_eq!(copy_conversation(&from, &to, "short").unwrap(), 0, "an id that would match too much is refused");
        #[cfg(unix)]
        {
            let outside = base.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join(format!("{sid}.secret")), "no").unwrap();
            std::os::unix::fs::symlink(&outside, from.join("linked")).unwrap();
            copy_conversation(&from, &to, sid).unwrap();
            assert!(!to.join("linked").exists(), "a linked directory is not followed");
        }
    }
}

#[cfg(test)]
mod background_tests {
    use super::background_session;

    #[test]
    fn reads_the_id_of_a_session_running_in_the_background() {
        let msg = "Internal error: Error: That session is running in the background (a2a3006e). Run `claude attach a2a3006e` to open it";
        assert_eq!(background_session(msg).as_deref(), Some("a2a3006e"));
        assert_eq!(background_session("That session is running in the background").as_deref(), Some(""));
        assert_eq!(background_session("Resource not found"), None);
    }
}
