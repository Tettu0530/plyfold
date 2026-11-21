//! A second agent reviews a session's diff after each turn, read-only, in a side session of its own

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Engine, EngineEvent, EngineOptions, StartSession};
use plyfold_profile::{Config, MemoryStore};
use tokio::sync::broadcast::Receiver;

fn mock_agent() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let ok = Command::new(env!("CARGO")).args(["build", "-q", "-p", "plyfold-acp", "--bin", "plyfold-mock-agent"]).status().unwrap().success();
        assert!(ok, "failed to build the mock agent");
        let target = std::env::var("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
        let exe = target.join(format!("debug/plyfold-mock-agent{}", std::env::consts::EXE_SUFFIX));
        real(&exe)
    })
    .clone()
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("plyfold-review-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    real(&d)
}

/// The path with symlinks resolved on macOS (/var → /private/var); Windows paths are used as they are, since
/// canonicalizing there adds a \\?\ prefix that git and the agents don't expect
fn real(p: &Path) -> PathBuf {
    assert!(p.exists(), "{} is missing", p.display());
    if cfg!(windows) { p.to_path_buf() } else { p.canonicalize().unwrap() }
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"]).args(args).current_dir(dir).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn engine(state: &Path) -> Engine {
    let toml = format!(
        r#"
[agents.mock]
# A literal string, so Windows backslashes stay as they are
command = '{}'
"#,
        mock_agent().display()
    );
    Engine::open(EngineOptions {
        state_dir: state.to_path_buf(),
        data_dir: None,
        config: Config::from_toml(&toml).unwrap(),
        secrets: Arc::new(MemoryStore::default()),
        stall_after: Duration::from_secs(60),
    })
    .unwrap()
}

async fn turn_ended(rx: &mut Receiver<EngineEvent>, id: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let EngineEvent::TurnEnded { session_id, .. } = rx.recv().await.unwrap()
                && session_id == id
            {
                return;
            }
        }
    })
    .await
    .expect("the turn did not end");
}

fn prompts_to(eng: &Engine, id: &str) -> Vec<String> {
    eng.store().events(id, None, 100_000).unwrap().into_iter().filter(|e| e.payload.contains("\"user_message_chunk\"")).map(|e| e.payload).collect()
}

#[tokio::test]
async fn each_turn_with_a_new_diff_is_reviewed_once() {
    let base = tmp("turns");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);
    // The mock agent keeps its history in the folder it works in; that is not part of the work
    std::fs::write(repo.join(".git/info/exclude"), ".plyfold-mock/\n").unwrap();
    let eng = engine(&base.join("state"));
    let mut rx = eng.subscribe();
    let s = eng.start_session(StartSession { profile: "mock".into(), title: "t".into(), repo: repo.clone(), worktree: false }).await.unwrap();

    // No reviewer: a turn is only a turn
    eng.prompt(&s.id, "hello").unwrap();
    turn_ended(&mut rx, &s.id).await;
    assert!(eng.store().list_sessions().unwrap().iter().all(|r| !r.review));

    let rec = eng.set_reviewer(&s.id, Some("mock")).await.unwrap();
    assert_eq!(rec.reviewer.as_deref(), Some("mock"));

    // A turn that leaves a diff: the reviewer is started and gets the instruction, the file and the diff
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    eng.prompt(&s.id, "add a second line").unwrap();
    turn_ended(&mut rx, &s.id).await;
    let reviewer = loop {
        if let Some(r) = eng.store().list_sessions().unwrap().into_iter().find(|r| r.review) {
            break r;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(reviewer.side_of.as_deref(), Some(s.id.as_str()));
    turn_ended(&mut rx, &reviewer.id).await;
    let asked = prompts_to(&eng, &reviewer.id);
    assert_eq!(asked.len(), 1, "{asked:#?}");
    assert!(asked[0].contains("add a second line") && asked[0].contains("a.txt") && asked[0].contains("+two"));

    // The same diff is not reviewed again
    eng.prompt(&s.id, "hello again").unwrap();
    turn_ended(&mut rx, &s.id).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(prompts_to(&eng, &reviewer.id).len(), 1);

    // Off: the reviewer goes, and the session no longer names one
    let rec = eng.set_reviewer(&s.id, None).await.unwrap();
    assert_eq!(rec.reviewer, None);
    assert!(eng.store().list_sessions().unwrap().iter().all(|r| !r.review));
    eng.close_session(&s.id).await.unwrap();
}
