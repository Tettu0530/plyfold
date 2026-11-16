//! コーディングのベンチマーク
//!
//! 小さな Rust の課題を、各経路のエージェントに解かせる。終わったら、
//! 見せたテストと Cargo.toml を元に戻し、隠しテストを足して、こちらで `cargo test` を実行して採点する。
//! 課題は乱数で作ったものではないが、意味のない練習問題だけで、機密は含まない。

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;

use crate::config::Config;
use crate::handler::Policy;
use crate::scenario::{self, Opts};

const AGENT_TIMEOUT: Duration = Duration::from_secs(900);
const TEST_TIMEOUT: Duration = Duration::from_secs(180);

struct TaskDef {
    id: &'static str,
    /// 隠しテストを含めたテストの総数
    total_tests: u32,
    files: &'static [(&'static str, &'static str)],
    hidden: &'static str,
}

macro_rules! task {
    ($id:literal, $total:expr, [$($path:literal),*]) => {
        TaskDef {
            id: $id,
            total_tests: $total,
            files: &[$(($path, include_str!(concat!("../codebench/", $id, "/", $path)))),*],
            hidden: include_str!(concat!("../codebench/", $id, "/hidden.rs")),
        }
    };
}

const TASKS: &[TaskDef] = &[
    task!("calc", 7, ["Cargo.toml", "README.md", "src/lib.rs", "tests/visible.rs"]),
    task!("lru", 8, ["Cargo.toml", "README.md", "src/lib.rs", "tests/visible.rs"]),
    task!("intervals", 7, ["Cargo.toml", "README.md", "src/lib.rs", "tests/visible.rs"]),
    task!("ini", 8, ["Cargo.toml", "README.md", "src/lib.rs", "tests/visible.rs"]),
];

const PROMPT: &str = "このディレクトリの Rust クレートの課題を解いてください。仕様は README.md にあります。\
`cargo test` がすべて通るようにしてください。tests/ の中のファイルと Cargo.toml は変更しないでください。\
終わったら、何をしたかを 1〜2 文で報告してください。";

#[derive(Debug, Serialize, serde::Deserialize, Clone, Default)]
pub struct CodeResult {
    pub task: String,
    pub passed: u32,
    pub total: u32,
    pub solved: bool,
    pub elapsed_ms: u128,
    pub tool_calls: u64,
    pub permission_requests: u64,
    pub stop_reason: Option<String>,
    /// テストか Cargo.toml を書き換えていた（採点の前に元に戻す）
    pub tampered: Vec<String>,
    pub models: BTreeSet<String>,
    pub error: Option<String>,
    pub workdir: PathBuf,
}

#[derive(Debug, Serialize, serde::Deserialize, Default)]
pub struct RouteResult {
    pub target: String,
    pub results: Vec<CodeResult>,
}

fn write_task(dir: &Path, task: &TaskDef) -> Result<()> {
    for (rel, content) in task.files {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap())?;
        std::fs::write(p, content)?;
    }
    // エージェントが git の状態を見られるように、最初の状態をコミットしておく
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"])
            .args(args)
            .current_dir(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    git(&["init", "-q"])?;
    std::fs::write(dir.join(".gitignore"), "/target\n")?;
    git(&["add", "-A"])?;
    git(&["commit", "-qm", "init"])?;
    Ok(())
}

/// テストと Cargo.toml を元に戻し、隠しテストを足して実行する。戻り値: (通った数, 書き換えられていたファイル)
async fn grade(dir: &Path, task: &TaskDef) -> Result<(u32, Vec<String>)> {
    let mut tampered = Vec::new();
    for (rel, content) in task.files {
        if *rel == "Cargo.toml" || rel.starts_with("tests/") {
            let p = dir.join(rel);
            if std::fs::read_to_string(&p).ok().as_deref() != Some(*content) {
                tampered.push(rel.to_string());
                std::fs::write(&p, content)?;
            }
        }
    }
    // 自分で足したテストファイルは採点に含めない
    for entry in std::fs::read_dir(dir.join("tests"))? {
        let p = entry?.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if name != "visible.rs" {
            tampered.push(format!("tests/{name}（追加）"));
            let _ = std::fs::remove_file(&p);
        }
    }
    std::fs::write(dir.join("tests/hidden.rs"), task.hidden)?;

    let mut cmd = tokio::process::Command::new("cargo");
    // 採点するのは見せたテストと隠しテストだけ（エージェントが足した単体テストは数えない）
    cmd.args(["test", "--no-fail-fast", "--test", "visible", "--test", "hidden"])
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(TEST_TIMEOUT, cmd.output()).await {
        Ok(o) => o?,
        Err(_) => return Ok((0, tampered)), // 時間内に終わらない（O(n) の LRU など）
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut passed = 0;
    for line in text.lines().filter(|l| l.starts_with("test result:")) {
        if let Some(n) = line.split("ok.").nth(1).or_else(|| line.split("FAILED.").nth(1)) {
            passed += n.trim().split(' ').next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
        }
    }
    Ok((passed, tampered))
}

async fn run_task(cfg: &Config, target: &str, opts: &Opts, task: &TaskDef, root: &Path) -> CodeResult {
    let dir = root.join(target).join(task.id);
    let mut res = CodeResult { task: task.id.into(), total: task.total_tests, workdir: dir.clone(), ..Default::default() };
    if let Err(e) = std::fs::create_dir_all(&dir).map_err(anyhow::Error::from).and_then(|_| write_task(&dir, task)) {
        res.error = Some(format!("課題の準備に失敗: {e:#}"));
        return res;
    }
    let opts = Opts { cwd: Some(dir.clone()), ..opts.clone() };
    let started = Instant::now();
    let outcome: Result<Option<String>> = async {
        let s = scenario::start(cfg, target, &opts, &format!("code-{}", task.id)).await?;
        let new = s.new_session().await?;
        let sid = new["sessionId"].as_str().context("sessionId がありません")?.to_string();
        let mode = if s.launch.agent == "codex" { "workspace-write" } else { "default" };
        let _ = s
            .conn
            .request_timeout("session/set_mode", json!({ "sessionId": sid, "modeId": mode }), Duration::from_secs(30))
            .await;
        let r = s
            .conn
            .request_timeout(
                "session/prompt",
                json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": PROMPT }] }),
                AGENT_TIMEOUT,
            )
            .await;
        {
            let stats = s.shared.stats.lock().unwrap();
            res.tool_calls = stats.updates.get("tool_call").copied().unwrap_or(0);
            res.permission_requests = stats.agent_requests.get("session/request_permission").copied().unwrap_or(0);
        }
        if let Some(m) = s.shared.turn.lock().unwrap().model.clone() {
            res.models.insert(m);
        }
        s.conn.shutdown().await;
        Ok(r?["stopReason"].as_str().map(str::to_string))
    }
    .await;
    res.elapsed_ms = started.elapsed().as_millis();
    match outcome {
        Ok(stop) => res.stop_reason = stop,
        Err(e) => res.error = Some(format!("{e:#}")),
    }
    match grade(&dir, task).await {
        Ok((passed, tampered)) => {
            res.passed = passed;
            res.tampered = tampered;
            res.solved = passed == task.total_tests;
        }
        Err(e) => res.error = Some(format!("採点に失敗: {e:#}")),
    }
    println!(
        "[{target}] {}: {}/{} {} {:.0}s ツール {} 回{}{}",
        task.id,
        res.passed,
        res.total,
        if res.solved { "○" } else { "×" },
        res.elapsed_ms as f64 / 1000.0,
        res.tool_calls,
        if res.tampered.is_empty() { String::new() } else { format!(" 書き換え: {}", res.tampered.join(", ")) },
        res.error.as_deref().map(|e| format!(" エラー: {e}")).unwrap_or_default()
    );
    res
}

pub async fn codebench(cfg: Arc<Config>, targets: Vec<String>, opts: Opts) -> Result<PathBuf> {
    let opts = Opts { quiet: true, policy: Policy::Allow, ..opts };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    // ユーザー名やプロジェクト名を含まない場所で作業させる
    let root = PathBuf::from(format!("/tmp/pfcode/{stamp}"));
    std::fs::create_dir_all(&root)?;

    let mut handles = Vec::new();
    for t in targets.clone() {
        let cfg = cfg.clone();
        let opts = opts.clone();
        let root = root.clone();
        handles.push(tokio::spawn(async move {
            let mut rr = RouteResult { target: t.clone(), results: Vec::new() };
            for task in TASKS {
                rr.results.push(run_task(&cfg, &t, &opts, task, &root).await);
            }
            rr
        }));
    }
    let mut routes = Vec::new();
    for h in handles {
        routes.push(h.await?);
    }

    let md = report(&targets, &routes, &root);
    let dir = opts.root.join("probe-runs");
    let path = dir.join(format!("codebench-{stamp}.md"));
    std::fs::write(&path, &md)?;
    std::fs::write(dir.join(format!("codebench-{stamp}.json")), serde_json::to_string_pretty(&routes)?)?;
    println!("\n{md}");
    Ok(path)
}

fn report(targets: &[String], routes: &[RouteResult], root: &Path) -> String {
    let mut md = String::from("# コーディングのベンチマーク\n\n");
    let _ = writeln!(md, "| 課題 | {} |", targets.join(" | "));
    let _ = writeln!(md, "|---|{}", "---|".repeat(targets.len()));
    for (i, task) in TASKS.iter().enumerate() {
        let cells: Vec<String> = routes
            .iter()
            .map(|r| {
                let x = &r.results[i];
                format!(
                    "{} {}/{}（{:.0}s, ツール {}）",
                    if x.solved { "○" } else { "×" },
                    x.passed,
                    x.total,
                    x.elapsed_ms as f64 / 1000.0,
                    x.tool_calls
                )
            })
            .collect();
        let _ = writeln!(md, "| {} | {} |", task.id, cells.join(" | "));
    }
    let sum = |r: &RouteResult| {
        let solved = r.results.iter().filter(|x| x.solved).count();
        let passed: u32 = r.results.iter().map(|x| x.passed).sum();
        let total: u32 = r.results.iter().map(|x| x.total).sum();
        let secs: f64 = r.results.iter().map(|x| x.elapsed_ms as f64 / 1000.0).sum();
        format!("**{solved}/{} 課題、テスト {passed}/{total}、計 {:.0}s**", r.results.len(), secs)
    };
    let _ = writeln!(md, "| 合計 | {} |", routes.iter().map(sum).collect::<Vec<_>>().join(" | "));
    let _ = writeln!(
        md,
        "| API が返したモデル名 | {} |",
        routes
            .iter()
            .map(|r| {
                let m: BTreeSet<String> = r.results.iter().flat_map(|x| x.models.iter().cloned()).collect();
                if m.is_empty() { "（取れない）".into() } else { m.into_iter().collect::<Vec<_>>().join(", ") }
            })
            .collect::<Vec<_>>()
            .join(" | ")
    );

    let _ = writeln!(md, "\n## 注記\n");
    for r in routes {
        for x in &r.results {
            if !x.tampered.is_empty() {
                let _ = writeln!(md, "- **{}** {}: テストか Cargo.toml を書き換えていた（{}）", r.target, x.task, x.tampered.join(", "));
            }
            if let Some(e) = &x.error {
                let _ = writeln!(md, "- **{}** {}: {e}", r.target, x.task);
            }
        }
    }
    let _ = writeln!(md, "\n作業フォルダ: `{}`", root.display());

    md
}

/// 作業フォルダを残したまま、採点だけやり直す（採点の不具合を直したとき用）
pub async fn regrade(json_path: &Path) -> Result<PathBuf> {
    let text = std::fs::read_to_string(json_path)?;
    let mut routes: Vec<RouteResult> = serde_json::from_str(&text)?;
    let mut root = PathBuf::new();
    for r in routes.iter_mut() {
        for x in r.results.iter_mut() {
            let task = TASKS.iter().find(|t| t.id == x.task).context("知らない課題")?;
            let (passed, tampered) = grade(&x.workdir, task).await?;
            x.passed = passed;
            x.total = task.total_tests;
            x.solved = passed == task.total_tests;
            // 1 回目の採点で元に戻したものは、2 回目には出てこないので合算する
            for t in tampered {
                if !x.tampered.contains(&t) && !t.starts_with("tests/hidden.rs") {
                    x.tampered.push(t);
                }
            }
            x.tampered.retain(|t| !t.starts_with("tests/hidden.rs"));
            root = x.workdir.parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
        }
    }
    let targets: Vec<String> = routes.iter().map(|r| r.target.clone()).collect();
    let md = report(&targets, &routes, &root);
    let out = json_path.with_extension("regraded.md");
    std::fs::write(&out, &md)?;
    std::fs::write(json_path.with_extension("regraded.json"), serde_json::to_string_pretty(&routes)?)?;
    println!("{md}");
    Ok(out)
}
