//! Queued tasks: prompts waiting to start as sessions, a set number at a time (the scheduling is in the UI, which
//! sees the sessions' states). Kept in <data dir>/tasks.json, so a development build has its own queue.

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Task {
    pub id: String,
    pub profile: String,
    pub repo: String,
    pub worktree: bool,
    pub prompt: String,
    pub title: String,
    pub created_at: i64,
    /// Why it could not start; it then waits until started again by hand
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The longest prompt kept (a queue of pasted logs would otherwise grow without bound)
const MAX_PROMPT: usize = 200_000;
const MAX_TASKS: usize = 200;

pub fn load(dir: &Path) -> Vec<Task> {
    std::fs::read_to_string(dir.join("tasks.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(dir: &Path, tasks: &[Task]) -> Result<(), String> {
    if tasks.len() > MAX_TASKS || tasks.iter().any(|t| t.prompt.len() > MAX_PROMPT || t.id.is_empty() || t.profile.is_empty()) {
        return Err(plyfold_i18n::tr!(
            "予約を保存できません（多すぎるか、長すぎます）",
            "Cannot save the queue (too many or too long)",
            "无法保存排队任务（过多或过长）"
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join("tasks.json");
    let tmp = dir.join(format!(".tasks.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(tasks).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_queue_round_trips_and_refuses_what_is_too_big() {
        let d = std::env::temp_dir().join(format!("plyfold-tasks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(load(&d).is_empty());
        let t = Task {
            id: "t1".into(),
            profile: "claude".into(),
            repo: "/r".into(),
            worktree: true,
            prompt: "fix it".into(),
            title: "fix it".into(),
            created_at: 1,
            error: None,
        };
        save(&d, std::slice::from_ref(&t)).unwrap();
        assert_eq!(load(&d), vec![t.clone()]);
        let big = Task { prompt: "x".repeat(MAX_PROMPT + 1), ..t };
        assert!(save(&d, &[big]).is_err());
        assert_eq!(load(&d).len(), 1, "a refused save leaves the queue as it was");
    }
}
