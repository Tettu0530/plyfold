//! プロファイルごとの使用状況（新しいセッションを始めるときに、どのキーをどれだけ使ったかを見せる）
//!
//! 記録（ACP の送受信のログ）から数える。消したセッションは記録ごと消えるので数えない
//! - ターン: 送った session/prompt
//! - トークン: ターンの結果の usage（届かないエージェントもある）
//! - 費用: usage_update の cost。通算で届くので、前の値との差を足す（減ったら開き直しなどで 0 から数え直したとみなす）

use std::collections::{HashMap, HashSet};

use plyfold_store::{EventKind, UsageEvent};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ProfileUsage {
    pub profile: String,
    pub agent: String,
    /// 期間中にプロンプトを送ったセッションの数
    pub sessions: u32,
    pub turns: u32,
    /// 入力トークン（キャッシュの読み書きを含む）。usage が一度も届かなければ None
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cost: Option<f64>,
    pub currency: Option<String>,
    /// 最後にプロンプトを送った時刻（ms）
    pub last_used: Option<i64>,
}

/// `since`（ms）以降の使用状況を、プロファイルごとに
pub fn summarize(events: &[UsageEvent], since: i64) -> Vec<ProfileUsage> {
    let mut by: HashMap<String, ProfileUsage> = HashMap::new();
    let mut sessions: HashMap<String, HashSet<String>> = HashMap::new();
    let mut last_cost: HashMap<String, f64> = HashMap::new();
    for e in events {
        let Ok(msg) = serde_json::from_str::<Value>(&e.payload) else { continue };
        let entry = by.entry(e.profile.clone()).or_insert_with(|| ProfileUsage { profile: e.profile.clone(), agent: e.agent.clone(), ..Default::default() });
        let inside = e.ts >= since;
        match e.kind {
            EventKind::FrameOut if msg["method"] == "session/prompt" => {
                if inside {
                    entry.turns += 1;
                    entry.last_used = Some(entry.last_used.map_or(e.ts, |t| t.max(e.ts)));
                    sessions.entry(e.profile.clone()).or_default().insert(e.session_id.clone());
                }
            }
            EventKind::FrameIn => {
                let update = &msg["params"]["update"];
                if update["sessionUpdate"] == "usage_update" {
                    let Some(amount) = update["cost"]["amount"].as_f64() else { continue };
                    let prev = last_cost.insert(e.session_id.clone(), amount).unwrap_or(0.0);
                    let delta = if amount >= prev { amount - prev } else { amount };
                    if inside {
                        *entry.cost.get_or_insert(0.0) += delta;
                        if entry.currency.is_none() {
                            entry.currency = update["cost"]["currency"].as_str().map(str::to_string).or(Some("USD".into()));
                        }
                    }
                } else if inside && msg["result"]["stopReason"].is_string() {
                    let u = &msg["result"]["usage"];
                    if u.is_object() {
                        let n = |k: &str| u[k].as_u64().unwrap_or(0);
                        *entry.input.get_or_insert(0) += n("inputTokens") + n("cachedReadTokens") + n("cachedWriteTokens");
                        *entry.output.get_or_insert(0) += n("outputTokens");
                    }
                }
            }
            _ => {}
        }
    }
    for (p, s) in sessions {
        if let Some(u) = by.get_mut(&p) {
            u.sessions = s.len() as u32;
        }
    }
    let mut out: Vec<ProfileUsage> = by.into_values().filter(|u| u.turns > 0 || u.cost.is_some()).collect();
    out.sort_by(|a, b| b.last_used.cmp(&a.last_used).then_with(|| a.profile.cmp(&b.profile)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(session: &str, profile: &str, ts: i64, kind: EventKind, payload: Value) -> UsageEvent {
        UsageEvent { session_id: session.into(), profile: profile.into(), agent: "claude".into(), ts, kind, payload: payload.to_string() }
    }
    fn prompt() -> Value {
        json!({"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {}})
    }
    fn result(input: u64, output: u64) -> Value {
        json!({"jsonrpc": "2.0", "id": 1, "result": {"stopReason": "end_turn", "usage": {"inputTokens": input, "cachedReadTokens": 10, "outputTokens": output}}})
    }
    fn cost(amount: f64) -> Value {
        json!({"jsonrpc": "2.0", "method": "session/update", "params": {"update": {"sessionUpdate": "usage_update", "cost": {"amount": amount, "currency": "USD"}}}})
    }

    #[test]
    fn counts_turns_tokens_and_cost_inside_the_window() {
        let events = vec![
            // 期間より前: 数えないが、費用の基準にはなる
            ev("s1", "work", 50, EventKind::FrameOut, prompt()),
            ev("s1", "work", 51, EventKind::FrameIn, cost(1.0)),
            ev("s1", "work", 100, EventKind::FrameOut, prompt()),
            ev("s1", "work", 101, EventKind::FrameIn, result(100, 20)),
            ev("s1", "work", 102, EventKind::FrameIn, cost(1.5)),
            // 開き直して費用が 0 から数え直し
            ev("s1", "work", 200, EventKind::FrameOut, prompt()),
            ev("s1", "work", 201, EventKind::FrameIn, cost(0.25)),
            ev("s2", "work", 300, EventKind::FrameOut, prompt()),
            ev("s3", "home", 150, EventKind::FrameOut, prompt()),
        ];
        let out = summarize(&events, 100);
        assert_eq!(out[0].profile, "work");
        let w = &out[0];
        assert_eq!((w.sessions, w.turns), (2, 3));
        assert_eq!((w.input, w.output), (Some(110), Some(20)));
        assert!((w.cost.unwrap() - 0.75).abs() < 1e-9);
        assert_eq!(w.last_used, Some(300));
        let h = &out[1];
        assert_eq!((h.profile.as_str(), h.turns, h.input, h.cost), ("home", 1, None, None));
    }
}
