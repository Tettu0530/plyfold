//! Session info: config options (model / effort / mode) and usage (tokens, context, speed, cost)
//!
//! Options that each agent names differently (Claude's `effort`, Codex's `reasoning_effort`, etc.)
//! are unified into one operation by their ACP `category` ([`Category`]).

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Model,
    /// effort / reasoning_effort
    ThoughtLevel,
    Mode,
    Other,
}

impl Category {
    fn parse(s: Option<&str>) -> Self {
        match s {
            Some("model") => Self::Model,
            Some("thought_level") => Self::ThoughtLevel,
            Some("mode") => Self::Mode,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Choice {
    pub value: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub category: Category,
    pub current: Option<String>,
    pub choices: Vec<Choice>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cached_read: u64,
    pub cached_write: u64,
    pub thought: u64,
    pub total: u64,
}

impl TokenUsage {
    fn from_json(v: &Value) -> Option<Self> {
        if !v.is_object() {
            return None;
        }
        let n = |k: &str| v[k].as_u64().unwrap_or(0);
        Some(Self {
            input: n("inputTokens"),
            output: n("outputTokens"),
            cached_read: n("cachedReadTokens"),
            cached_write: n("cachedWriteTokens"),
            thought: n("thoughtTokens"),
            total: n("totalTokens"),
        })
    }

    fn add(&mut self, o: &Self) {
        self.input += o.input;
        self.output += o.output;
        self.cached_read += o.cached_read;
        self.cached_write += o.cached_write;
        self.thought += o.thought;
        self.total += o.total;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cost {
    pub amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TurnStats {
    pub usage: Option<TokenUsage>,
    pub elapsed_ms: u64,
    /// Time until the first character arrives
    pub ttft_ms: Option<u64>,
    /// Output tokens per second (from the first character to the end)
    pub tokens_per_sec: Option<f64>,
    /// If true, estimated from the character count because no token count was available
    pub estimated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LiveTurn {
    pub elapsed_ms: u64,
    pub ttft_ms: Option<u64>,
    pub streamed_chars: u64,
    /// Estimated tokens per second while streaming (characters ÷ 4)
    pub est_tokens_per_sec: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SessionInfo {
    pub config: Vec<ConfigOption>,
    /// Legacy modes (for agents whose configOptions have no mode)
    pub modes: Vec<Choice>,
    pub current_mode: Option<String>,
    pub context_used: Option<u64>,
    pub context_size: Option<u64>,
    pub cost: Option<Cost>,
    /// Model name the API actually returned (only for agents that report it)
    pub reported_model: Option<String>,
    pub last_turn: Option<TurnStats>,
    pub total: TokenUsage,
    pub live: Option<LiveTurn>,
}

impl SessionInfo {
    pub fn option(&self, cat: Category) -> Option<&ConfigOption> {
        self.config.iter().find(|o| o.category == cat)
    }

    /// From the session/new or session/load response
    pub(crate) fn apply_session_response(&mut self, r: &Value) {
        if let Some(opts) = r.get("configOptions").filter(|v| v.is_array()) {
            self.config = parse_config(opts);
        }
        if let Some(modes) = r.get("modes").filter(|v| v.is_object()) {
            self.modes = modes["availableModes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| Choice {
                    value: m["id"].as_str().unwrap_or_default().into(),
                    name: m["name"].as_str().unwrap_or_default().into(),
                })
                .collect();
            self.current_mode = modes["currentModeId"].as_str().map(str::to_string);
        }
    }

    pub(crate) fn set_config(&mut self, opts: &Value) {
        if opts.is_array() {
            self.config = parse_config(opts);
        }
    }

    /// Apply the info-related parts of a session/update. Returns true if anything changed
    pub(crate) fn apply_update(&mut self, u: &Value) -> bool {
        match u["sessionUpdate"].as_str() {
            Some("usage_update") => {
                self.context_used = u["used"].as_u64().or(self.context_used);
                self.context_size = u["size"].as_u64().or(self.context_size);
                if let Some(amount) = u["cost"]["amount"].as_f64() {
                    self.cost = Some(Cost { amount, currency: u["cost"]["currency"].as_str().unwrap_or("USD").into() });
                }
                if let Some(m) = u["_meta"]["_claude/model"].as_str() {
                    self.reported_model = Some(m.into());
                }
                true
            }
            Some("config_option_update") => {
                self.set_config(&u["configOptions"]);
                true
            }
            Some("current_mode_update") => {
                let id = u["currentModeId"].as_str().map(str::to_string);
                self.current_mode = id.clone();
                if let Some(o) = self.config.iter_mut().find(|o| o.category == Category::Mode) {
                    o.current = id;
                }
                true
            }
            _ => false,
        }
    }
}

fn parse_config(opts: &Value) -> Vec<ConfigOption> {
    opts.as_array()
        .into_iter()
        .flatten()
        .map(|o| ConfigOption {
            id: o["id"].as_str().unwrap_or_default().into(),
            name: o["name"].as_str().or(o["id"].as_str()).unwrap_or_default().into(),
            category: Category::parse(o["category"].as_str()),
            current: o["currentValue"].as_str().map(str::to_string),
            choices: flatten_choices(&o["options"]),
        })
        .collect()
}

/// Choices may be nested in groups ({ group, options: [...] })
fn flatten_choices(v: &Value) -> Vec<Choice> {
    let mut out = Vec::new();
    for item in v.as_array().into_iter().flatten() {
        if let Some(inner) = item.get("options").filter(|x| x.is_array()) {
            out.extend(flatten_choices(inner));
        } else if let Some(value) = item["value"].as_str() {
            out.push(Choice { value: value.into(), name: item["name"].as_str().unwrap_or(value).into() });
        }
    }
    out
}

/// Timing for a single turn
pub(crate) struct TurnClock {
    pub started: Instant,
    pub first_token: Option<Instant>,
    pub chars: u64,
}

impl TurnClock {
    pub fn new() -> Self {
        Self { started: Instant::now(), first_token: None, chars: 0 }
    }

    pub fn on_text(&mut self, text: &str) {
        self.first_token.get_or_insert_with(Instant::now);
        self.chars += text.chars().count() as u64;
    }

    pub fn live(&self) -> LiveTurn {
        let ttft = self.first_token.map(|t| t.duration_since(self.started));
        let est = self.first_token.and_then(|t| {
            let secs = t.elapsed().as_secs_f64();
            (secs >= 0.5).then(|| self.chars as f64 / 4.0 / secs)
        });
        LiveTurn {
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            ttft_ms: ttft.map(|d| d.as_millis() as u64),
            streamed_chars: self.chars,
            est_tokens_per_sec: est,
        }
    }

    pub fn finish(&self, usage: &Value) -> TurnStats {
        let usage = TokenUsage::from_json(usage);
        let gen_secs = self.first_token.map(|t| t.elapsed().as_secs_f64());
        let (tps, estimated) = match (usage.map(|u| u.output), gen_secs) {
            (Some(out), Some(secs)) if out > 0 && secs >= 0.2 => (Some(out as f64 / secs), false),
            (_, Some(secs)) if self.chars > 0 && secs >= 0.2 => (Some(self.chars as f64 / 4.0 / secs), true),
            _ => (None, false),
        };
        TurnStats {
            usage,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            ttft_ms: self.first_token.map(|t| t.duration_since(self.started).as_millis() as u64),
            tokens_per_sec: tps,
            estimated,
        }
    }
}

impl SessionInfo {
    pub(crate) fn finish_turn(&mut self, stats: TurnStats) {
        if let Some(u) = &stats.usage {
            self.total.add(u);
        }
        self.last_turn = Some(stats);
        self.live = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_real_shapes() {
        let mut info = SessionInfo::default();
        // Codex's shape (effort is named reasoning_effort)
        info.apply_session_response(&json!({
            "configOptions": [
                {"id": "model", "name": "Model", "category": "model", "currentValue": "gpt-a",
                 "options": [{"value": "gpt-a", "name": "A"}, {"group": "more", "options": [{"value": "gpt-b", "name": "B"}]}]},
                {"id": "reasoning_effort", "category": "thought_level", "currentValue": "low", "options": [{"value": "low"}, {"value": "high"}]},
                {"id": "fast-mode", "category": "model_config", "currentValue": "off", "options": [{"value": "off"}, {"value": "on"}]}
            ],
            "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}]}
        }));
        let model = info.option(Category::Model).unwrap();
        assert_eq!(model.choices.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["gpt-a", "gpt-b"]);
        assert_eq!(info.option(Category::ThoughtLevel).unwrap().id, "reasoning_effort");
        assert_eq!(info.config[2].category, Category::Other);
        assert_eq!(info.current_mode.as_deref(), Some("default"));

        assert!(info.apply_update(&json!({"sessionUpdate": "usage_update", "used": 9256, "size": 200000,
            "cost": {"amount": 0.12, "currency": "USD"}, "_meta": {"_claude/model": "real-model"}})));
        assert_eq!((info.context_used, info.context_size), (Some(9256), Some(200000)));
        assert_eq!(info.cost.as_ref().unwrap().amount, 0.12);
        assert_eq!(info.reported_model.as_deref(), Some("real-model"));
        assert!(!info.apply_update(&json!({"sessionUpdate": "agent_message_chunk"})));
    }

    #[test]
    fn turn_stats_prefer_tokens_and_fall_back_to_chars() {
        let mut clock = TurnClock::new();
        clock.on_text("hello world");
        std::thread::sleep(std::time::Duration::from_millis(250));
        let exact = clock.finish(&json!({"inputTokens": 10, "outputTokens": 50, "totalTokens": 60}));
        assert!(!exact.estimated);
        assert!(exact.tokens_per_sec.unwrap() > 50.0 && exact.tokens_per_sec.unwrap() < 250.0);
        let est = clock.finish(&Value::Null);
        assert!(est.estimated && est.usage.is_none());

        let mut info = SessionInfo::default();
        info.finish_turn(exact.clone());
        info.finish_turn(exact);
        assert_eq!(info.total.output, 100);
    }
}
