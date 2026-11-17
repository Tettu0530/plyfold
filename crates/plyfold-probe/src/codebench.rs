//! Coding benchmark
//!
//! Each route's agent solves small Rust tasks. Afterwards we restore the visible
//! tests and Cargo.toml, add the hidden tests, and grade by running `cargo test` ourselves.
//! The tasks are not randomly generated, but they are throwaway exercises with nothing confidential.

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
    /// Total number of tests, hidden ones included
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

const PROMPT: &str = "Solve the task for the Rust crate in this directory. The spec is in README.md. \
Make `cargo test` pass completely. Do not modify the files under tests/ or Cargo.toml. \
When you are done, report what you did in one or two sentences.";

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
    /// Tests or Cargo.toml the agent modified (restored before grading)
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
    // Commit the initial state so the agent can inspect it with git
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

/// Restore the tests and Cargo.toml, add the hidden tests and run them. Returns (tests passed, files that had been modified)
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
    // Test files the agent added itself are not graded
    for entry in std::fs::read_dir(dir.join("tests"))? {
        let p = entry?.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if name != "visible.rs" {
            tampered.push(format!("tests/{name} (added)"));
            let _ = std::fs::remove_file(&p);
        }
    }
    std::fs::write(dir.join("tests/hidden.rs"), task.hidden)?;

    let mut cmd = tokio::process::Command::new("cargo");
    // Grade only the visible and hidden tests (unit tests the agent added don't count)
    cmd.args(["test", "--no-fail-fast", "--test", "visible", "--test", "hidden"])
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(TEST_TIMEOUT, cmd.output()).await {
        Ok(o) => o?,
        Err(_) => return Ok((0, tampered)), // did not finish in time (e.g. an O(n) LRU)
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
        res.error = Some(format!("failed to set up the task: {e:#}"));
        return res;
    }
    let opts = Opts { cwd: Some(dir.clone()), ..opts.clone() };
    let started = Instant::now();
    let outcome: Result<Option<String>> = async {
        let s = scenario::start(cfg, target, &opts, &format!("code-{}", task.id)).await?;
        let new = s.new_session().await?;
        let sid = new["sessionId"].as_str().context("missing sessionId")?.to_string();
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
        Err(e) => res.error = Some(format!("grading failed: {e:#}")),
    }
    println!(
        "[{target}] {}: {}/{} {} {:.0}s {} tool calls{}{}",
        task.id,
        res.passed,
        res.total,
        if res.solved { "○" } else { "×" },
        res.elapsed_ms as f64 / 1000.0,
        res.tool_calls,
        if res.tampered.is_empty() { String::new() } else { format!(" modified: {}", res.tampered.join(", ")) },
        res.error.as_deref().map(|e| format!(" error: {e}")).unwrap_or_default()
    );
    res
}

pub async fn codebench(cfg: Arc<Config>, targets: Vec<String>, opts: Opts) -> Result<PathBuf> {
    let opts = Opts { quiet: true, policy: Policy::Allow, ..opts };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    // Work in a path that contains no user or project name
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
    let mut md = String::from("# Coding benchmark\n\n");
    let _ = writeln!(md, "| task | {} |", targets.join(" | "));
    let _ = writeln!(md, "|---|{}", "---|".repeat(targets.len()));
    for (i, task) in TASKS.iter().enumerate() {
        let cells: Vec<String> = routes
            .iter()
            .map(|r| {
                let x = &r.results[i];
                format!(
                    "{} {}/{} ({:.0}s, {} tools)",
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
        format!("**{solved}/{} tasks, tests {passed}/{total}, {:.0}s total**", r.results.len(), secs)
    };
    let _ = writeln!(md, "| total | {} |", routes.iter().map(sum).collect::<Vec<_>>().join(" | "));
    let _ = writeln!(
        md,
        "| model name returned by the API | {} |",
        routes
            .iter()
            .map(|r| {
                let m: BTreeSet<String> = r.results.iter().flat_map(|x| x.models.iter().cloned()).collect();
                if m.is_empty() { "(unavailable)".into() } else { m.into_iter().collect::<Vec<_>>().join(", ") }
            })
            .collect::<Vec<_>>()
            .join(" | ")
    );

    let _ = writeln!(md, "\n## Notes\n");
    for r in routes {
        for x in &r.results {
            if !x.tampered.is_empty() {
                let _ = writeln!(md, "- **{}** {}: modified the tests or Cargo.toml ({})", r.target, x.task, x.tampered.join(", "));
            }
            if let Some(e) = &x.error {
                let _ = writeln!(md, "- **{}** {}: {e}", r.target, x.task);
            }
        }
    }
    let _ = writeln!(md, "\nWork folder: `{}`", root.display());

    md
}

/// Regrade only, keeping the work folders (for after fixing a grading bug)
pub async fn regrade(json_path: &Path) -> Result<PathBuf> {
    let text = std::fs::read_to_string(json_path)?;
    let mut routes: Vec<RouteResult> = serde_json::from_str(&text)?;
    let mut root = PathBuf::new();
    for r in routes.iter_mut() {
        for x in r.results.iter_mut() {
            let task = TASKS.iter().find(|t| t.id == x.task).context("unknown task")?;
            let (passed, tampered) = grade(&x.workdir, task).await?;
            x.passed = passed;
            x.total = task.total_tests;
            x.solved = passed == task.total_tests;
            // Files restored by the first grading won't show up again, so merge the lists
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
