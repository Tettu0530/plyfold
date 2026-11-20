//! Storage for sessions and the event log (SQLite)
//!
//! A session is Plyfold's unit of record. It outlives the pane that displays it.
//! Rather than relying on each CLI's own history (session/load), all ACP traffic is recorded here.
//! A conversation adopted from the CLI is the exception: its history is the resend from session/load, copied out of that resend so it can be shown.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{}", plyfold_i18n::tr!("データベースのエラー: {}", "Database error: {}", "数据库错误：{}", .0))]
    Sql(#[from] rusqlite::Error),
    #[error("{}", plyfold_i18n::tr!("セッション {} がありません", "Session {} not found", "会话 {} 不存在", .0))]
    NotFound(String),
    #[error("{}", plyfold_i18n::tr!("ディレクトリを作れません: {}", "Cannot create the directory: {}", "无法创建目录：{}", .0))]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// The agent is starting
    Starting,
    /// Waiting for input
    Idle,
    /// In the middle of a turn
    Working,
    /// Waiting for a permission answer
    AwaitingPermission,
    /// Mid-turn, but nothing has arrived for a while
    Stalled,
    /// The agent crashed or failed to start
    Error,
    /// The agent was stopped (the record remains)
    Closed,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Idle => "idle",
            Self::Working => "working",
            Self::AwaitingPermission => "awaiting_permission",
            Self::Stalled => "stalled",
            Self::Error => "error",
            Self::Closed => "closed",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "starting" => Self::Starting,
            "idle" => Self::Idle,
            "working" => Self::Working,
            "awaiting_permission" => Self::AwaitingPermission,
            "stalled" => Self::Stalled,
            "error" => Self::Error,
            _ => Self::Closed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub profile: String,
    pub agent: String,
    pub repo_path: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    /// The agent-side session ID (used for session/load)
    pub acp_session_id: Option<String>,
    pub status: SessionStatus,
    pub created_at: i64,
    pub updated_at: i64,
    /// For a side chat: the session it was forked from. Side chats are read-only, kept out of the session list,
    /// and deleted when closed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_of: Option<String>,
    /// An everyday conversation rather than work in a repository: it runs in its own empty folder, and may search and
    /// read the web but not edit or run commands
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub chat: bool,
    /// When it was moved to the trash (ms). A trashed session keeps its record and worktree until it is deleted for
    /// good, so it can be restored as it was
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<i64>,
    /// The port given to this session's dev servers (PORT in the agent's environment); kept for its lifetime
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Sessions started together from one prompt to compare share this id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_group: Option<String>,
    /// The profile that reviews this session's diff after each turn (None: no review)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    /// A side session that reviews the session in side_of (rather than a side chat)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub review: bool,
}

#[derive(Debug, Clone, Default)]
pub struct NewSession {
    pub title: String,
    pub profile: String,
    pub agent: String,
    pub repo_path: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    pub side_of: Option<String>,
    pub chat: bool,
    pub review: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    /// JSON-RPC received from the agent (redacted)
    FrameIn,
    /// JSON-RPC sent to the agent (redacted)
    FrameOut,
    /// A transcript copy that is not usage: a fork, or history resent when a CLI conversation is adopted
    ForkIn,
    /// A frame copied from the session this one was forked from. Kept out of usage totals
    ForkOut,
    /// A status change
    Status,
    /// Plyfold's own notes (launch, errors, stall detection, ...)
    Note,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::FrameIn => "frame_in",
            Self::FrameOut => "frame_out",
            Self::ForkIn => "fork_in",
            Self::ForkOut => "fork_out",
            Self::Status => "status",
            Self::Note => "note",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "frame_in" => Self::FrameIn,
            "frame_out" => Self::FrameOut,
            "fork_in" => Self::ForkIn,
            "fork_out" => Self::ForkOut,
            "status" => Self::Status,
            _ => Self::Note,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventRecord {
    pub id: i64,
    pub session_id: String,
    pub ts: i64,
    pub kind: EventKind,
    pub payload: String,
}

pub struct Store {
    conn: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn new_id() -> String {
    use std::hash::{BuildHasher, RandomState};
    let r = RandomState::new().hash_one(now_ms());
    format!("s{:x}{:08x}", now_ms(), r as u32)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    profile TEXT NOT NULL,
    agent TEXT NOT NULL,
    repo_path TEXT,
    worktree_path TEXT,
    branch TEXT,
    base_ref TEXT,
    acp_session_id TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS dismissed_conversations (
    acp_session_id TEXT PRIMARY KEY
);
";

const SESSION_COLS: &str = "id, title, profile, agent, repo_path, worktree_path, branch, base_ref, acp_session_id, status, created_at, updated_at, side_of, chat, trashed_at, port, run_group, reviewer, review";

fn row_to_session(r: &rusqlite::Row) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: r.get(0)?,
        title: r.get(1)?,
        profile: r.get(2)?,
        agent: r.get(3)?,
        repo_path: r.get(4)?,
        worktree_path: r.get(5)?,
        branch: r.get(6)?,
        base_ref: r.get(7)?,
        acp_session_id: r.get(8)?,
        status: SessionStatus::parse(&r.get::<_, String>(9)?),
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        side_of: r.get(12)?,
        chat: r.get::<_, i64>(13)? != 0,
        trashed_at: r.get(14)?,
        port: r.get(15)?,
        run_group: r.get(16)?,
        reviewer: r.get(17)?,
        review: r.get::<_, i64>(18)? != 0,
    })
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // The log holds conversations and the agents' output: readable by this user only (SQLite gives the -wal and
        // -shm files the database file's mode)
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
            std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(path)?;
            for p in [path.to_path_buf(), path.with_extension("db-wal"), path.with_extension("db-shm")] {
                if p.exists() {
                    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
                }
            }
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, StoreError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        // Columns added later (missing from older records)
        let has_lock: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'title_locked'")?.exists([])?;
        if !has_lock {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0")?;
        }
        let has_side: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'side_of'")?.exists([])?;
        if !has_side {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN side_of TEXT")?;
        }
        let has_chat: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'chat'")?.exists([])?;
        if !has_chat {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN chat INTEGER NOT NULL DEFAULT 0")?;
        }
        let has_trash: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'trashed_at'")?.exists([])?;
        if !has_trash {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN trashed_at INTEGER")?;
        }
        let has_port: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'port'")?.exists([])?;
        if !has_port {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN port INTEGER")?;
        }
        let has_group: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'run_group'")?.exists([])?;
        if !has_group {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN run_group TEXT")?;
        }
        let has_reviewer: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'reviewer'")?.exists([])?;
        if !has_reviewer {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN reviewer TEXT; ALTER TABLE sessions ADD COLUMN review INTEGER NOT NULL DEFAULT 0")?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn create_session(&self, s: NewSession) -> Result<SessionRecord, StoreError> {
        let now = now_ms();
        let rec = SessionRecord {
            id: new_id(),
            title: s.title,
            profile: s.profile,
            agent: s.agent,
            repo_path: s.repo_path,
            worktree_path: s.worktree_path,
            branch: s.branch,
            base_ref: s.base_ref,
            acp_session_id: None,
            status: SessionStatus::Starting,
            created_at: now,
            updated_at: now,
            side_of: s.side_of,
            chat: s.chat,
            trashed_at: None,
            port: None,
            run_group: None,
            reviewer: None,
            review: s.review,
        };
        self.conn.lock().unwrap().execute(
            &format!("INSERT INTO sessions ({SESSION_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)"),
            params![
                rec.id,
                rec.title,
                rec.profile,
                rec.agent,
                rec.repo_path,
                rec.worktree_path,
                rec.branch,
                rec.base_ref,
                rec.acp_session_id,
                rec.status.as_str(),
                rec.created_at,
                rec.updated_at,
                rec.side_of,
                rec.chat as i64,
                rec.trashed_at,
                rec.port,
                rec.run_group,
                rec.reviewer,
                rec.review as i64
            ],
        )?;
        Ok(rec)
    }

    pub fn get_session(&self, id: &str) -> Result<SessionRecord, StoreError> {
        self.conn
            .lock()
            .unwrap()
            .query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1"), [id], row_to_session)
            .optional()?
            .ok_or_else(|| StoreError::NotFound(id.into()))
    }

    /// Most recently updated first
    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT {SESSION_COLS} FROM sessions ORDER BY updated_at DESC, id DESC"))?;
        let rows = stmt.query_map([], row_to_session)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn update(&self, id: &str, column: &str, value: &dyn rusqlite::ToSql) -> Result<(), StoreError> {
        let n =
            self.conn.lock().unwrap().execute(&format!("UPDATE sessions SET {column} = ?1, updated_at = ?2 WHERE id = ?3"), params![value, now_ms(), id])?;
        if n == 0 {
            return Err(StoreError::NotFound(id.into()));
        }
        Ok(())
    }

    pub fn set_status(&self, id: &str, status: SessionStatus) -> Result<(), StoreError> {
        self.update(id, "status", &status.as_str())?;
        self.append_event(id, EventKind::Status, status.as_str())?;
        Ok(())
    }

    /// Continue the session with another profile (another key of the same agent)
    pub fn set_profile(&self, id: &str, profile: &str) -> Result<(), StoreError> {
        self.update(id, "profile", &profile)
    }

    /// The profile that reviews the session after each turn (None turns review off)
    pub fn set_reviewer(&self, id: &str, profile: Option<&str>) -> Result<(), StoreError> {
        self.update(id, "reviewer", &profile)
    }

    pub fn set_run_group(&self, id: &str, group: Option<&str>) -> Result<(), StoreError> {
        self.update(id, "run_group", &group)
    }

    pub fn set_port(&self, id: &str, port: u16) -> Result<(), StoreError> {
        self.update(id, "port", &port)
    }

    /// Move to the trash (Some(now)) or back out of it (None)
    pub fn set_trashed(&self, id: &str, at: Option<i64>) -> Result<(), StoreError> {
        self.update(id, "trashed_at", &at)
    }

    pub fn set_acp_session_id(&self, id: &str, acp_session_id: &str) -> Result<(), StoreError> {
        self.update(id, "acp_session_id", &acp_session_id)
    }

    /// Records the working directory after the worktree is created
    pub fn set_workspace(
        &self,
        id: &str,
        repo_path: Option<&str>,
        worktree_path: Option<&str>,
        branch: Option<&str>,
        base_ref: Option<&str>,
    ) -> Result<(), StoreError> {
        let n = self.conn.lock().unwrap().execute(
            "UPDATE sessions SET repo_path = ?1, worktree_path = ?2, branch = ?3, base_ref = ?4, updated_at = ?5 WHERE id = ?6",
            params![repo_path, worktree_path, branch, base_ref, now_ms(), id],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(id.into()));
        }
        Ok(())
    }

    pub fn set_title(&self, id: &str, title: &str) -> Result<(), StoreError> {
        self.update(id, "title", &title)
    }

    /// The user renamed it. From now on, agent-provided titles no longer overwrite it
    pub fn rename_by_user(&self, id: &str, title: &str) -> Result<(), StoreError> {
        let n = self
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE sessions SET title = ?1, title_locked = 1, updated_at = ?2 WHERE id = ?3", params![title, now_ms(), id])?;
        if n == 0 {
            return Err(StoreError::NotFound(id.into()));
        }
        Ok(())
    }

    /// A title from the agent. Applied unless the user has renamed the session (sort order is unchanged). Returns true if applied
    pub fn set_title_from_agent(&self, id: &str, title: &str) -> Result<bool, StoreError> {
        let n = self.conn.lock().unwrap().execute("UPDATE sessions SET title = ?1 WHERE id = ?2 AND title_locked = 0 AND title <> ?1", params![title, id])?;
        Ok(n > 0)
    }

    /// Deletes the whole record (events included)
    pub fn delete_session(&self, id: &str) -> Result<(), StoreError> {
        self.conn.lock().unwrap().execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Remember an agent-side conversation Plyfold made and threw away (a closed side chat), so it is not offered
    /// as a conversation to open from the CLI
    pub fn dismiss_conversation(&self, acp_session_id: &str) -> Result<(), StoreError> {
        self.conn.lock().unwrap().execute("INSERT OR IGNORE INTO dismissed_conversations (acp_session_id) VALUES (?1)", [acp_session_id])?;
        Ok(())
    }

    pub fn dismissed_conversations(&self) -> Result<Vec<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT acp_session_id FROM dismissed_conversations")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        Ok(rows)
    }

    pub fn append_event(&self, session_id: &str, kind: EventKind, payload: &str) -> Result<i64, StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT INTO events (session_id, ts, kind, payload) VALUES (?1, ?2, ?3, ?4)", params![session_id, now_ms(), kind.as_str(), payload])?;
        Ok(conn.last_insert_rowid())
    }

    /// The history `session/load` resent between these notes is inside the load request, so the transcript skips it.
    /// Rewrite those updates so they are not usage, and append a copy after the notes so the transcript can show it.
    /// Used when adopting a CLI conversation, which has no earlier copy of its own.
    pub fn keep_resent_history(&self, session_id: &str, begin_note: &str, end_note: &str) -> Result<(), StoreError> {
        let mut events = Vec::new();
        let mut after = None;
        loop {
            let page = self.events(session_id, after, 2000)?;
            let Some(last) = page.last() else { break };
            after = Some(last.id);
            let done = page.len() < 2000;
            events.extend(page);
            if done {
                break;
            }
        }
        let mut begin = None;
        let mut end = None;
        for e in &events {
            if e.kind == EventKind::Note && e.payload == begin_note {
                begin = Some(e.id);
                end = None;
            }
            if e.kind == EventKind::Note && e.payload == end_note && begin.is_some() {
                end = Some(e.id);
            }
        }
        let (Some(begin), Some(end)) = (begin, end) else { return Ok(()) };
        let copied: Vec<_> = events
            .iter()
            .filter(|e| e.id > begin && e.id < end && e.kind == EventKind::FrameIn && e.payload.contains("session/update"))
            .map(|e| (e.id, e.ts, e.payload.clone()))
            .collect();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (id, _, _) in &copied {
            tx.execute("UPDATE events SET kind = 'fork_in' WHERE id = ?1 AND kind = 'frame_in'", [id])?;
        }
        for (_, ts, payload) in &copied {
            tx.execute("INSERT INTO events (session_id, ts, kind, payload) VALUES (?1, ?2, 'fork_in', ?3)", params![session_id, ts, payload])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Copies the source session's ACP frames so the fork shows the same conversation.
    /// Stored as `fork_in` / `fork_out` so usage totals are not counted twice. Timestamps are kept.
    pub fn copy_transcript(&self, from: &str, to: &str) -> Result<usize, StoreError> {
        let n = self.conn.lock().unwrap().execute(
            "INSERT INTO events (session_id, ts, kind, payload)
             SELECT ?1, ts, CASE kind WHEN 'frame_in' THEN 'fork_in' ELSE 'fork_out' END, payload
             FROM events WHERE session_id = ?2 AND kind IN ('frame_in', 'frame_out')
             ORDER BY id",
            params![to, from],
        )?;
        Ok(n)
    }

    /// Events after `after`, oldest first (from the start if `after` is None)
    pub fn events(&self, session_id: &str, after: Option<i64>, limit: usize) -> Result<Vec<EventRecord>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, session_id, ts, kind, payload FROM events WHERE session_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3")?;
        let rows = stmt
            .query_map(params![session_id, after.unwrap_or(0), limit as i64], |r| {
                Ok(EventRecord { id: r.get(0)?, session_id: r.get(1)?, ts: r.get(2)?, kind: EventKind::parse(&r.get::<_, String>(3)?), payload: r.get(4)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

/// An event used for usage totals (with the session's profile)
#[derive(Debug, Clone)]
pub struct UsageEvent {
    pub session_id: String,
    pub profile: String,
    pub agent: String,
    pub ts: i64,
    pub kind: EventKind,
    pub payload: String,
}

impl Store {
    /// Prompt, turn-result and usage-update events of sessions updated since `since`, oldest first.
    /// Costs arrive as running totals, so earlier events are returned too, to allow taking differences
    pub fn usage_events(&self, since: i64) -> Result<Vec<UsageEvent>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT e.session_id, s.profile, s.agent, e.ts, e.kind, e.payload FROM events e JOIN sessions s ON s.id = e.session_id
             WHERE s.updated_at >= ?1 AND (
               (e.kind = 'frame_out' AND e.payload LIKE '%\"session/prompt\"%') OR
               (e.kind = 'frame_in' AND (e.payload LIKE '%\"stopReason\"%' OR e.payload LIKE '%\"usage_update\"%')))
             ORDER BY e.id",
        )?;
        let rows = stmt
            .query_map(params![since], |r| {
                Ok(UsageEvent {
                    session_id: r.get(0)?,
                    profile: r.get(1)?,
                    agent: r.get(2)?,
                    ts: r.get(3)?,
                    kind: EventKind::parse(&r.get::<_, String>(4)?),
                    payload: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(store: &Store, title: &str) -> SessionRecord {
        store.create_session(NewSession { title: title.into(), profile: "p".into(), agent: "mock".into(), ..Default::default() }).unwrap()
    }

    #[test]
    fn errors_follow_the_language() {
        plyfold_i18n::set_lang("en");
        assert_eq!(StoreError::NotFound("s1".into()).to_string(), "Session s1 not found");
        plyfold_i18n::set_lang("ja");
        assert_eq!(StoreError::NotFound("s1".into()).to_string(), "セッション s1 がありません");
    }

    #[test]
    fn agent_titles_do_not_override_user_names() {
        let store = Store::open_in_memory().unwrap();
        let s = new(&store, "最初の指示");
        assert!(store.set_title_from_agent(&s.id, "リポジトリの概要").unwrap());
        assert!(!store.set_title_from_agent(&s.id, "リポジトリの概要").unwrap(), "an identical title is not rewritten");
        store.rename_by_user(&s.id, "自分で付けた名前").unwrap();
        assert!(!store.set_title_from_agent(&s.id, "別のタイトル").unwrap());
        assert_eq!(store.get_session(&s.id).unwrap().title, "自分で付けた名前");
    }

    #[test]
    fn usage_events_keep_only_prompts_results_and_usage() {
        let store = Store::open_in_memory().unwrap();
        let s = new(&store, "t");
        store.append_event(&s.id, EventKind::FrameOut, r#"{"method":"session/prompt"}"#).unwrap();
        store.append_event(&s.id, EventKind::FrameIn, r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}"#).unwrap();
        store.append_event(&s.id, EventKind::FrameIn, r#"{"params":{"update":{"sessionUpdate":"usage_update"}}}"#).unwrap();
        store.append_event(&s.id, EventKind::FrameIn, r#"{"result":{"stopReason":"end_turn"}}"#).unwrap();
        store.append_event(&s.id, EventKind::Note, "session/prompt").unwrap();
        let got = store.usage_events(0).unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].profile, "p");
        assert!(store.usage_events(now_ms() + 60_000).unwrap().is_empty());
    }

    #[test]
    fn session_lifecycle() {
        let store = Store::open_in_memory().unwrap();
        let s = new(&store, "first");
        assert_eq!(s.status, SessionStatus::Starting);
        store.set_acp_session_id(&s.id, "acp-1").unwrap();
        store.set_status(&s.id, SessionStatus::Idle).unwrap();
        let got = store.get_session(&s.id).unwrap();
        assert_eq!(got.acp_session_id.as_deref(), Some("acp-1"));
        assert_eq!(got.status, SessionStatus::Idle);
        assert!(matches!(store.get_session("nope"), Err(StoreError::NotFound(_))));
        assert!(matches!(store.set_title("nope", "x"), Err(StoreError::NotFound(_))));
    }

    #[test]
    fn events_paging_and_cascade() {
        let store = Store::open_in_memory().unwrap();
        let s = new(&store, "a");
        let other = new(&store, "b");
        for i in 0..5 {
            store.append_event(&s.id, EventKind::FrameIn, &format!("{{\"n\":{i}}}")).unwrap();
        }
        store.append_event(&other.id, EventKind::Note, "x").unwrap();
        let first = store.events(&s.id, None, 2).unwrap();
        assert_eq!(first.len(), 2);
        let rest = store.events(&s.id, Some(first[1].id), 100).unwrap();
        assert_eq!(rest.len(), 3);
        assert!(rest.iter().all(|e| e.kind == EventKind::FrameIn && e.session_id == s.id));
        store.delete_session(&s.id).unwrap();
        assert!(store.events(&s.id, None, 100).unwrap().is_empty());
        assert_eq!(store.events(&other.id, None, 100).unwrap().len(), 1);
    }

    #[test]
    fn copied_transcript_keeps_the_text_and_stays_out_of_usage() {
        let store = Store::open_in_memory().unwrap();
        let src = new(&store, "src");
        let prompt = r#"{"method":"session/prompt"}"#;
        store.append_event(&src.id, EventKind::FrameOut, prompt).unwrap();
        store.append_event(&src.id, EventKind::Note, "skip").unwrap();
        let dst = new(&store, "dst");
        assert_eq!(store.copy_transcript(&src.id, &dst.id).unwrap(), 1);
        let copied = store.events(&dst.id, None, 10).unwrap();
        assert_eq!(copied.len(), 1);
        assert_eq!(copied[0].kind, EventKind::ForkOut);
        assert_eq!(copied[0].payload, prompt);
        assert_eq!(copied[0].session_id, dst.id);
        let usage = store.usage_events(0).unwrap();
        assert!(usage.iter().all(|e| e.session_id == src.id));
    }

    #[test]
    fn list_orders_by_update() {
        let store = Store::open_in_memory().unwrap();
        let a = new(&store, "a");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = new(&store, "b");
        assert_eq!(store.list_sessions().unwrap()[0].id, b.id);
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.set_title(&a.id, "a2").unwrap();
        let list = store.list_sessions().unwrap();
        assert_eq!(list[0].id, a.id);
        assert_eq!(list[0].title, "a2");
    }

    #[cfg(unix)]
    #[test]
    fn the_database_is_readable_by_its_user_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("plyfold-store-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = dir.join("plyfold.db");
        let store = Store::open(&db).unwrap();
        store.create_session(NewSession::default()).unwrap();
        for p in [db.clone(), db.with_extension("db-wal")] {
            if p.exists() {
                assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600, "{}", p.display());
            }
        }
    }

    #[test]
    fn persists_on_disk() {
        let path = std::env::temp_dir().join(format!("plyfold-store-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let id = {
            let store = Store::open(&path).unwrap();
            let s = new(&store, "disk");
            store.append_event(&s.id, EventKind::Note, "hello").unwrap();
            s.id
        };
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get_session(&id).unwrap().title, "disk");
        assert_eq!(store.events(&id, None, 10).unwrap()[0].payload, "hello");
    }
}
