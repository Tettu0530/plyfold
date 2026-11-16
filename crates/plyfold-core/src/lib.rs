//! Plyfold のエンジン: プロファイル・worktree・ACP・記録を束ねる
//!
//! UI（Tauri など）はこのエンジンだけを触る。状態の変化は [`EngineEvent`] として配信する。
//! - セッション（記録）とエージェントのプロセス（実行）は別物。プロセスを止めても記録は残り、`reopen_session` で再開できる
//! - 権限確認は UI に回し、返事を `respond_permission` で受け取る
//! - ターンの途中で一定時間なにも届かなければ `Stalled` にする（検証で、終わらないエージェントがいたため）

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

pub mod check;
pub mod info;
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
    #[error("セッション {0} のエージェントは動いていません")]
    NotRunning(String),
    #[error("セッション {0} のエージェントはもう動いています")]
    AlreadyRunning(String),
    #[error("セッション {0} はターンの途中です")]
    Busy(String),
    #[error("権限確認 {0} は見つかりません（すでに返事済みか、ターンが終わっています）")]
    UnknownPermission(String),
    #[error("セッション {0} には作業場所がありません")]
    NoWorkspace(String),
    #[error("このエージェントには {0:?} の設定項目がありません")]
    NoSuchOption(Category),
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
    /// session/update の `update` の部分（生の JSON。UI が種類ごとに描く）
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
    /// 人に知らせたいこと（起動の失敗、無応答、開き直しの結果など）
    Notice { session_id: String, message: String },
    /// 設定項目と使用量（変わるたびに全体を送る。流れている途中は 0.5 秒ごと）
    Info { session_id: String, info: Box<SessionInfo> },
}

pub struct EngineOptions {
    pub state_dir: PathBuf,
    pub config: Config,
    pub secrets: Arc<dyn SecretStore>,
    /// ターンの途中でこれだけ何も届かなければ Stalled にする
    pub stall_after: Duration,
}

pub struct StartSession {
    /// プロファイル名かエージェント名
    pub profile: String,
    pub title: String,
    /// 作業するリポジトリ（またはディレクトリ）
    pub repo: PathBuf,
    /// true ならセッション専用の worktree を切る（repo は git リポジトリであること）
    pub worktree: bool,
}

struct Live {
    client: AcpClient,
    acp_sid: Mutex<String>,
    /// permission_id → JSON-RPC のリクエスト ID
    permissions: Mutex<HashMap<String, Value>>,
    last_activity: Mutex<Instant>,
    in_turn: AtomicBool,
    stalled: AtomicBool,
    closing: AtomicBool,
    /// pump が処理し終えた AgentMessage の数（区切りと比べる）
    processed: AtomicU64,
    progress: tokio::sync::Notify,
    info: Mutex<SessionInfo>,
    clock: Mutex<Option<TurnClock>>,
    last_live_emit: Mutex<Instant>,
}

impl Live {
    /// 区切りまでの AgentMessage を pump が処理し終えるのを待つ（念のため上限つき）
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
    /// 画面からプロファイルを編集したら差し替える（動いているセッションには影響しない）
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
            tracing::warn!("状態を保存できません: {e}");
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

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    pub fn open(opts: EngineOptions) -> Result<Self, CoreError> {
        let store = Store::open(&opts.state_dir.join("plyfold.db"))?;
        // 前回の起動で動いていたセッションは、プロセスがもうないので Closed にする
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

    /// 接続テスト（記録には残さない）
    pub async fn check_profile(&self, profile: &str) -> check::CheckResult {
        let config = self.inner.config.read().unwrap().clone();
        check::check_profile(&config, profile, &self.inner.state_dir, self.inner.secrets.as_ref()).await
    }

    /// プロファイルの設定を差し替える（次に起動するセッションから効く）
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
                inner.notice(&rec.id, format!("作業場所を用意できません: {e}"));
                inner.set_status(&rec.id, SessionStatus::Error);
                return Err(e);
            }
        };
        self.launch(&rec.id, &req.profile, &cwd, None).await?;
        Ok(inner.store.get_session(&rec.id)?)
    }

    /// 止まっているセッションのエージェントを起動し直す。対応していれば session/load で文脈ごと戻す
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

            // Inner → Live → 接続 → sink → Inner の循環を作らないよう、弱参照で持つ
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
            });
            // session/load の履歴の再送を受け取るため、先に受信を始める
            tokio::spawn(pump(inner.clone(), id.to_string(), live.clone(), rx));

            let opened: Result<String, CoreError> = async {
                // 開き直せないときの理由（新しいセッションで続けるときに知らせる）
                let mut fallback = None;
                if let Some(old) = &reopen {
                    if live.client.supports_load_session() {
                        match live.client.load_session(old, cwd).await {
                            Ok((resp, barrier)) => {
                                live.wait_processed(barrier).await;
                                live.info.lock().unwrap().apply_session_response(&resp);
                                inner.notice(id, "session/load で開き直しました（履歴はエージェントから再送されます）");
                                return Ok(old.clone());
                            }
                            // エージェントの側に会話の記録がない（書き残す前に終わったなど）。新しいセッションで続ける
                            Err(AcpError::Rpc { code: -32002, .. }) => {
                                fallback = Some("エージェントの側にこの会話の記録が見つからないため、新しいセッションを作りました（文脈は引き継がれません。Plyfold の記録は残っています）");
                            }
                            Err(e) => return Err(e.into()),
                        }
                    } else {
                        fallback = Some("このエージェントは開き直しに対応していないため、新しいセッションを作りました（文脈は引き継がれません）");
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
                        inner.notice(id, format!("stderr の最後:\n{}", tail.join("\n")));
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
                inner.notice(id, format!("エージェントを起動できません: {e}"));
                inner.set_status(id, SessionStatus::Error);
                Err(e)
            }
        }
    }

    /// ターンを始める。終わるのは待たない（終わったら TurnEnded が届く）
    pub fn prompt(&self, id: &str, text: &str) -> Result<(), CoreError> {
        let inner = self.inner.clone();
        let live = inner.live(id)?;
        if live.in_turn.swap(true, Ordering::SeqCst) {
            return Err(CoreError::Busy(id.into()));
        }
        live.touch();
        live.stalled.store(false, Ordering::SeqCst);
        *live.clock.lock().unwrap() = Some(TurnClock::new());
        live.info.lock().unwrap().live = Some(LiveTurn::default());
        inner.set_status(id, SessionStatus::Working);
        let id = id.to_string();
        let text = text.to_string();
        tokio::spawn(async move {
            let r = live.client.prompt(&live.sid(), &text).await;
            live.in_turn.store(false, Ordering::SeqCst);
            live.permissions.lock().unwrap().clear();
            match r {
                Ok(turn) => {
                    // このターンの通知を配信し終えてから、ターンの終わりを知らせる
                    live.wait_processed(turn.barrier).await;
                    finish_turn(&inner, &id, &live, &turn.raw["usage"]);
                    let stop = serde_json::to_value(turn.response.stop_reason).ok().and_then(|v| v.as_str().map(str::to_string));
                    inner.emit(EngineEvent::TurnEnded { session_id: id.clone(), stop_reason: stop, error: None });
                }
                Err(e) => {
                    finish_turn(&inner, &id, &live, &Value::Null);
                    inner.notice(&id, format!("ターンがエラーで終わりました: {e}"));
                    inner.emit(EngineEvent::TurnEnded { session_id: id.clone(), stop_reason: None, error: Some(e.to_string()) });
                }
            }
            if !live.closing.load(Ordering::SeqCst) {
                inner.set_status(&id, SessionStatus::Idle);
            }
        });
        Ok(())
    }

    /// 中断。返事待ちの権限確認は「キャンセル」で返す（ACP の決まり）
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

    /// option_id が None ならキャンセル扱い
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

    /// 今のセッション情報（エージェントが動いていなければ None）
    pub fn session_info(&self, id: &str) -> Option<SessionInfo> {
        self.inner.live(id).ok().map(|l| l.info.lock().unwrap().clone())
    }

    /// 設定項目を ID で変える
    pub async fn set_config_option(&self, id: &str, config_id: &str, value: &str) -> Result<(), CoreError> {
        let live = self.inner.live(id)?;
        let opts = live.client.set_config_option(&live.sid(), config_id, value).await?;
        live.info.lock().unwrap().set_config(&opts);
        emit_info(&self.inner, id, &live);
        Ok(())
    }

    /// model / effort / mode を、エージェントごとの名前の違いを気にせずに変える。
    /// mode は configOptions になければ旧来の session/set_mode を使う
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

    /// エージェントを止める（記録と worktree は残る）
    pub async fn close_session(&self, id: &str) -> Result<(), CoreError> {
        let live = self.inner.live.lock().unwrap().remove(id);
        if let Some(live) = live {
            live.closing.store(true, Ordering::SeqCst);
            live.client.shutdown().await;
        }
        self.inner.set_status(id, SessionStatus::Closed);
        Ok(())
    }

    /// 記録ごと消す。`remove_worktree` なら worktree と枝も消す（作業内容は失われる）
    pub async fn delete_session(&self, id: &str, remove_worktree: bool) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        self.close_session(id).await?;
        if remove_worktree && let Some(wt) = worktree_of(&rec) {
            self.inner.worktrees.remove(&wt, true)?;
        }
        self.inner.store.delete_session(id)?;
        Ok(())
    }

    /// worktree の差分（作ったときのコミットから、今の作業ツリーまで）
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

    pub fn worktree_status(&self, id: &str) -> Result<plyfold_worktree::WtStatus, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        Ok(plyfold_worktree::ops::status(&wt)?)
    }

    /// 作業ツリーの変更をすべてコミットする（ターンの途中はできない）
    pub fn commit(&self, id: &str, message: &str) -> Result<String, CoreError> {
        let wt = self.idle_worktree(id)?;
        let hash = plyfold_worktree::ops::commit(&wt, message)?;
        self.inner.notice(id, format!("コミットしました: {hash} {}", message.lines().next().unwrap_or("")));
        Ok(hash)
    }

    /// 元のリポジトリで今チェックアウトしている枝へ取り込む
    pub fn merge(&self, id: &str) -> Result<String, CoreError> {
        let wt = self.idle_worktree(id)?;
        let target = plyfold_worktree::ops::merge(&wt)?;
        self.inner.notice(id, format!("{} を {target} に取り込みました", wt.branch));
        Ok(target)
    }

    /// 枝を push して PR を作る。URL を返す
    pub fn create_pr(&self, id: &str) -> Result<String, CoreError> {
        let wt = self.idle_worktree(id)?;
        let title = self.inner.store.get_session(id)?.title;
        let url = plyfold_worktree::ops::create_pr(&wt, &title)?;
        self.inner.notice(id, format!("PR を作りました: {url}"));
        Ok(url)
    }

    pub fn open_in_editor(&self, id: &str, prefer: &str) -> Result<String, CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        Ok(plyfold_worktree::ops::open_in_editor(&wt, prefer)?)
    }

    /// 取り込んだ後の片付け: エージェントを止め、worktree と枝を消す。記録は残り、開き直すと元のリポジトリで動く
    pub async fn cleanup_worktree(&self, id: &str) -> Result<(), CoreError> {
        let rec = self.inner.store.get_session(id)?;
        let wt = worktree_of(&rec).ok_or_else(|| CoreError::NoWorkspace(id.into()))?;
        self.close_session(id).await?;
        self.inner.worktrees.remove(&wt, true)?;
        self.inner.store.set_workspace(id, rec.repo_path.as_deref(), None, None, None)?;
        self.inner.notice(id, format!("worktree と枝 {} を片付けました", wt.branch));
        Ok(())
    }

    /// 無応答とみなすまでの時間を変える（次の見張りから効く）
    pub fn set_stall_after(&self, d: Duration) {
        self.inner.stall_after_ms.store(d.as_millis() as u64, Ordering::SeqCst);
    }

    /// 作業ツリーを基準のコミットまで戻す
    pub fn discard(&self, id: &str) -> Result<(), CoreError> {
        let wt = self.idle_worktree(id)?;
        plyfold_worktree::ops::discard(&wt)?;
        self.inner.notice(id, format!("変更を破棄して、{} に戻しました", &wt.base[..wt.base.len().min(7)]));
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
                inner.emit(EngineEvent::Update { session_id: id.clone(), update: update.clone() });
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
                    title: v["toolCall"]["title"].as_str().unwrap_or("（タイトルなし）").into(),
                    tool_call: v["toolCall"].clone(),
                    options,
                });
            }
            AgentMessage::OtherRequest { request_id, method, .. } => {
                let _ = live.client.respond_unsupported(request_id).await;
                inner.notice(&id, format!("未対応のリクエスト {method} を断りました"));
            }
            AgentMessage::OtherNotification { .. } => {}
            AgentMessage::Closed => {
                inner.live.lock().unwrap().remove(&id);
                if !live.closing.load(Ordering::SeqCst) {
                    let tail = live.client.connection().stderr_tail();
                    let mut msg = "エージェントのプロセスが終了しました".to_string();
                    if !tail.is_empty() {
                        msg += &format!("\nstderr の最後:\n{}", tail.iter().rev().take(20).rev().cloned().collect::<Vec<_>>().join("\n"));
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
            inner.notice(&id, format!("{} 秒間、エージェントから何も届いていません", idle.as_secs()));
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
