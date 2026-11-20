//! Handing a session over to another profile: a note from the old agent, then a new session in the same folder

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use plyfold_core::{Engine, EngineEvent, EngineOptions, StartSession};
use plyfold_profile::{Config, MemoryStore};
use plyfold_store::{EventKind, SessionStatus};
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
    let d = std::env::temp_dir().join(format!("plyfold-handover-{name}-{}", std::process::id()));
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
command = '{}'
[profiles.other]
agent = "mock"
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
    eng.store()
        .events(id, None, 100_000)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == EventKind::FrameOut && e.payload.contains("\"session/prompt\""))
        .map(|e| e.payload)
        .collect()
}

#[tokio::test]
async fn the_new_agent_gets_the_instructions_the_note_and_the_diff() {
    let base = tmp("over");
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join(".git/info/exclude"), ".plyfold-mock/\n").unwrap();
    let eng = engine(&base.join("state"));
    let mut rx = eng.subscribe();
    let s = eng.start_session(StartSession { profile: "mock".into(), title: "Work".into(), repo: repo.clone(), worktree: false }).await.unwrap();
    eng.prompt(&s.id, "add a second line").unwrap();
    turn_ended(&mut rx, &s.id).await;
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();

    let new = eng.hand_over(&s.id, "other").await.unwrap();
    assert_eq!(new.profile, "other");
    assert_eq!(new.repo_path, s.repo_path);
    assert_eq!(new.title, "Work");
    assert!(!eng.is_running(&s.id));
    assert_eq!(eng.store().get_session(&s.id).unwrap().status, SessionStatus::Closed);

    // The old agent was asked for a note (the mock echoes it back), and the new one got everything
    let old = prompts_to(&eng, &s.id);
    assert_eq!(old.len(), 2, "the instruction and the note request");
    turn_ended(&mut rx, &new.id).await;
    let sent = prompts_to(&eng, &new.id);
    assert_eq!(sent.len(), 1);
    let p = &sent[0];
    assert!(p.contains("add a second line"), "the instruction");
    assert!(p.contains("echo: "), "the old agent's note");
    assert!(p.contains("a.txt") && p.contains("+two"), "the diff");
    eng.close_session(&new.id).await.unwrap();
}
