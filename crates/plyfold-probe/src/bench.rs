//! 軽いベンチマーク: 経路ごとの差（本物のモデルか、別物か）をはっきり出す
//!
//! 1. トークナイザーの指紋: 同じ文章を足したときに増える入力トークン数。
//!    差を取るので、CLI のシステムプロンプトや、途中で足される見えない指示の分は打ち消される。
//! 2. 答えが決まった問題（乱数で作る）: 掛け算、べき乗の剰余、曜日、文字数え
//! 3. 速さ: 最初の文字が届くまでの時間と、全体の時間
//!
//! 送る内容は乱数で作った問題と固定の文章だけにする（中継で記録されても困らないもの）。

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Value, json};

use crate::config::Config;
use crate::handler::Turn;
use crate::scenario::{self, Opts, Session};

const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);
const SUFFIX: &str = "\n\nツールやコマンドは使わず、頭の中だけで解いてください。\
最後の行に `ANSWER: <答え>` の形で、答えだけを書いてください。";

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

#[derive(Clone)]
struct Task {
    id: &'static str,
    name: &'static str,
    prompt: String,
    answer: String,
}

fn pow_mod(base: u64, mut exp: u64, m: u64) -> u64 {
    let mut acc: u128 = 1;
    let mut b = (base % m) as u128;
    let m = m as u128;
    while exp > 0 {
        if exp & 1 == 1 {
            acc = acc * b % m;
        }
        b = b * b % m;
        exp >>= 1;
    }
    acc as u64
}

fn digit_sum_pow2(k: u32) -> u32 {
    // 2^k を 10 進の桁の配列で計算する
    let mut digits = vec![1u32];
    for _ in 0..k {
        let mut carry = 0;
        for d in digits.iter_mut() {
            let v = *d * 2 + carry;
            *d = v % 10;
            carry = v / 10;
        }
        if carry > 0 {
            digits.push(carry);
        }
    }
    digits.iter().sum()
}

fn make_tasks(trial: u64) -> Vec<Task> {
    let mut r = Rng(0x00C0_FFEE ^ trial.wrapping_mul(0x1000_0001));
    let a = r.range(100_000_000_000_000, 999_999_999_999_999);
    let b = r.range(100_000_000_000_000, 999_999_999_999_999);
    let (pb, pe, pm) = (r.range(1000, 9999), r.range(10_000, 99_999), r.range(100_000, 999_999));
    let k = r.range(150, 250) as u32;
    let s: String = (0..200).map(|_| b"rnmvwu"[r.range(0, 5) as usize] as char).collect();
    vec![
        Task {
            id: "mul",
            name: "15 桁 × 15 桁",
            prompt: format!("{a} × {b} を正確に計算してください。"),
            answer: (a as u128 * b as u128).to_string(),
        },
        Task {
            id: "modpow",
            name: "べき乗の剰余",
            prompt: format!("{pb} の {pe} 乗を {pm} で割った余りを求めてください。"),
            answer: pow_mod(pb, pe, pm).to_string(),
        },
        Task {
            id: "digitsum",
            name: "2^k の各桁の和",
            prompt: format!("2 の {k} 乗を 10 進数で書いたときの、各桁の数字の和を求めてください。"),
            answer: digit_sum_pow2(k).to_string(),
        },
        Task {
            id: "count",
            name: "文字数え（200 文字）",
            prompt: format!("次の文字列に r はいくつ含まれますか。\n{s}"),
            answer: s.chars().filter(|&c| c == 'r').count().to_string(),
        },
    ]
}

/// トークナイザーの指紋用の固定の文章（英語・日本語・コードを混ぜる）
fn filler() -> String {
    let mut s = String::new();
    for i in 0..12 {
        let _ = write!(
            s,
            "Paragraph {i}: The quick brown fox jumps over the lazy dog while counting prime numbers. \
             第{i}段落：吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。\
             fn step_{i}(x: u64) -> u64 {{ x.wrapping_mul(6364136223846793005).rotate_left({i}) }}\n"
        );
    }
    s
}

fn extract_answer(text: &str) -> Option<String> {
    let idx = text.rfind("ANSWER:")?;
    let line = text[idx + "ANSWER:".len()..].lines().next().unwrap_or("");
    let cleaned: String = line
        .chars()
        .filter(|c| !matches!(c, '*' | '`' | ',' | ' ' | '　' | '.' | '。' | '_'))
        .collect();
    Some(cleaned)
}

#[derive(Debug, Serialize, Clone)]
pub struct TaskResult {
    pub task: String,
    pub trial: u64,
    pub ok: bool,
    pub expected: String,
    pub got: Option<String>,
    pub ttft_ms: Option<u128>,
    pub total_ms: u128,
    pub chars: usize,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct TargetResult {
    pub target: String,
    pub agent: String,
    pub model_setting: String,
    pub reported_models: BTreeSet<String>,
    pub token_delta: Option<i64>,
    pub results: Vec<TaskResult>,
    pub error: Option<String>,
}

/// 新しいセッションを作る（Codex は読み取り専用にする）
async fn open(s: &Session) -> Result<(String, Value)> {
    let new = s.new_session().await?;
    let sid = new["sessionId"].as_str().context("sessionId がありません")?.to_string();
    if s.launch.agent == "codex" {
        let _ = s
            .conn
            .request_timeout("session/set_mode", json!({ "sessionId": sid, "modeId": "read-only" }), PROMPT_TIMEOUT)
            .await;
    }
    Ok((sid, new))
}

/// 既存のセッションで 1 回聞く。戻り値: (ターンの記録, 全体の ms, 最初の文字までの ms)
async fn ask_in(s: &Session, sid: &str, text: &str) -> Result<(Turn, u128, Option<u128>)> {
    s.shared.reset_turn();
    let t0 = Instant::now();
    s.conn
        .request_timeout(
            "session/prompt",
            json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": text }] }),
            PROMPT_TIMEOUT,
        )
        .await?;
    let total = t0.elapsed().as_millis();
    // usage_update がターンの終わりの直後に来ることがある
    tokio::time::sleep(Duration::from_millis(300)).await;
    let turn = s.shared.turn.lock().unwrap().clone();
    let ttft = turn.first_text_at.map(|at| at.duration_since(t0).as_millis());
    Ok((turn, total, ttft))
}

fn setting_of(new_session: &Value) -> String {
    let opts = new_session["configOptions"].as_array().cloned().unwrap_or_default();
    let get = |ids: &[&str]| {
        opts.iter()
            .find(|o| ids.contains(&o["id"].as_str().unwrap_or("")))
            .and_then(|o| o["currentValue"].as_str().map(str::to_string))
    };
    let model = get(&["model"]).unwrap_or_else(|| "?".into());
    match get(&["effort", "reasoning_effort"]) {
        Some(e) => format!("{model} / {e}"),
        None => model,
    }
}

async fn bench_target(cfg: &Config, target: &str, opts: &Opts, trials: u64) -> Result<TargetResult> {
    let s = scenario::start(cfg, target, opts, "bench").await?;
    let mut out = TargetResult {
        target: target.to_string(),
        agent: s.launch.agent.clone(),
        ..Default::default()
    };

    // 1. トークナイザーの指紋
    let short = "OK とだけ答えてください。";
    let long = format!("次の文章は読まずに、OK とだけ答えてください。\n---\n{}", filler());
    // 同じセッションで続けて送り、増えた分を見る（セッションごとのシステムプロンプトの揺れを消す）
    let (sid, new) = open(&s).await?;
    out.model_setting = setting_of(&new);
    let (t_short, _, _) = ask_in(&s, &sid, short).await?;
    let (t_long, _, _) = ask_in(&s, &sid, &long).await?;
    for t in [&t_short, &t_long] {
        if let Some(m) = &t.model {
            out.reported_models.insert(m.clone());
        }
    }
    if let (Some(a), Some(b)) = (t_short.used, t_long.used) {
        out.token_delta = Some(b as i64 - a as i64);
    }
    println!("[{target}] トークン差: {:?}", out.token_delta);

    // 2. 答えが決まった問題
    for trial in 0..trials {
        for task in make_tasks(trial) {
            let started = Instant::now();
            let r = match open(&s).await {
                Ok((sid, _)) => ask_in(&s, &sid, &format!("{}{SUFFIX}", task.prompt)).await,
                Err(e) => Err(e),
            };
            let res = match r {
                Ok((turn, total, ttft)) => {
                    if let Some(m) = &turn.model {
                        out.reported_models.insert(m.clone());
                    }
                    let got = extract_answer(&turn.text);
                    let ok = got.as_deref().map(|g| g.eq_ignore_ascii_case(&task.answer)).unwrap_or(false);
                    TaskResult {
                        task: task.id.into(),
                        trial,
                        ok,
                        expected: task.answer.clone(),
                        got,
                        ttft_ms: ttft,
                        total_ms: total,
                        chars: turn.text.chars().count(),
                        error: None,
                    }
                }
                Err(e) => TaskResult {
                    task: task.id.into(),
                    trial,
                    ok: false,
                    expected: task.answer.clone(),
                    got: None,
                    ttft_ms: None,
                    total_ms: started.elapsed().as_millis(),
                    chars: 0,
                    error: Some(format!("{e:#}")),
                },
            };
            println!(
                "[{target}] {} #{trial}: {} （期待 {} / 回答 {}）{:.1}s",
                task.name,
                if res.ok { "○" } else { "×" },
                res.expected,
                res.got.as_deref().unwrap_or("-"),
                res.total_ms as f64 / 1000.0
            );
            out.results.push(res);
        }
    }
    s.conn.shutdown().await;
    Ok(out)
}

fn median(mut v: Vec<u128>) -> Option<u128> {
    if v.is_empty() {
        return None;
    }
    v.sort();
    Some(v[v.len() / 2])
}

pub async fn bench(cfg: Arc<Config>, targets: Vec<String>, opts: Opts, trials: u64) -> Result<PathBuf> {
    let opts = Opts { quiet: true, ..opts };
    let mut handles = Vec::new();
    for t in targets.clone() {
        let cfg = cfg.clone();
        let opts = opts.clone();
        handles.push(tokio::spawn(async move {
            match bench_target(&cfg, &t, &opts, trials).await {
                Ok(r) => r,
                Err(e) => TargetResult { target: t, error: Some(format!("{e:#}")), ..Default::default() },
            }
        }));
    }
    let mut results = Vec::new();
    for h in handles {
        results.push(h.await?);
    }

    let task_ids: Vec<(&str, &str)> = make_tasks(0).iter().map(|t| (t.id, t.name)).collect();
    let mut md = String::from("# ベンチマーク結果\n\n");
    let _ = writeln!(md, "| 項目 | {} |", targets.join(" | "));
    let _ = writeln!(md, "|---|{}", "---|".repeat(targets.len()));
    let row = |md: &mut String, name: &str, f: &dyn Fn(&TargetResult) -> String| {
        let cells: Vec<String> = results
            .iter()
            .map(|r| if r.error.is_some() && r.results.is_empty() { "-".into() } else { f(r) })
            .collect();
        let _ = writeln!(md, "| {name} | {} |", cells.join(" | "));
    };
    row(&mut md, "設定上のモデル", &|r| r.model_setting.clone());
    row(&mut md, "API が返したモデル名", &|r| {
        if r.reported_models.is_empty() { "（取れない）".into() } else { r.reported_models.iter().cloned().collect::<Vec<_>>().join(", ") }
    });
    row(&mut md, "**トークン差**（同じ文章）", &|r| r.token_delta.map(|d| format!("**{d}**")).unwrap_or("-".into()));
    for (id, name) in &task_ids {
        row(&mut md, name, &|r| {
            let rs: Vec<&TaskResult> = r.results.iter().filter(|x| x.task == *id).collect();
            format!("{}/{}", rs.iter().filter(|x| x.ok).count(), rs.len())
        });
    }
    row(&mut md, "**合計正答**", &|r| format!("**{}/{}**", r.results.iter().filter(|x| x.ok).count(), r.results.len()));
    row(&mut md, "最初の文字まで（中央値）", &|r| {
        median(r.results.iter().filter_map(|x| x.ttft_ms).collect())
            .map(|m| format!("{:.1}s", m as f64 / 1000.0))
            .unwrap_or("-".into())
    });
    row(&mut md, "全体（中央値）", &|r| {
        median(r.results.iter().map(|x| x.total_ms).collect())
            .map(|m| format!("{:.1}s", m as f64 / 1000.0))
            .unwrap_or("-".into())
    });

    let _ = writeln!(md, "\n## 間違い・エラー\n");
    for r in &results {
        if let Some(e) = &r.error {
            let _ = writeln!(md, "- **{}**: {e}", r.target);
        }
        for x in r.results.iter().filter(|x| !x.ok) {
            let _ = writeln!(
                md,
                "- **{}** {} #{}: 期待 `{}` / 回答 `{}`{}",
                r.target,
                x.task,
                x.trial,
                x.expected,
                x.got.as_deref().unwrap_or("-"),
                x.error.as_deref().map(|e| format!("（{e}）")).unwrap_or_default()
            );
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = opts.root.join("probe-runs");
    let path = dir.join(format!("bench-{stamp}.md"));
    std::fs::write(&path, &md)?;
    std::fs::write(dir.join(format!("bench-{stamp}.json")), serde_json::to_string_pretty(&results)?)?;
    println!("\n{md}");
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values() {
        assert_eq!(digit_sum_pow2(15), 26); // 32768
        assert_eq!(digit_sum_pow2(1000), 1366);
        assert_eq!(pow_mod(4, 13, 497), 445);
        assert_eq!(extract_answer("考えた結果…\nANSWER: **1,234**"), Some("1234".into()));
    }
}
