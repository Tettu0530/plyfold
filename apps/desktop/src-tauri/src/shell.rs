//! `!command` in the composer: run a shell command in the session's folder and stream its output.
//! It never reaches the agent unless the user sends the result on.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{State, WebviewWindow, ipc::Channel};

use crate::{AppState, CmdResult, err};

/// Output beyond this is dropped (a runaway command should not fill the UI's memory)
const OUTPUT_LIMIT: usize = 512 * 1024;

#[derive(Default)]
pub struct Shells {
    next: AtomicU32,
    running: Arc<Mutex<HashMap<u32, Arc<Mutex<Child>>>>>,
}

impl Shells {
    fn running_handle(&self) -> Arc<Mutex<HashMap<u32, Arc<Mutex<Child>>>>> {
        Arc::clone(&self.running)
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellEvent {
    Output { data: String },
    Exit { code: Option<i32>, truncated: bool },
}

fn require_main(window: &WebviewWindow) -> CmdResult<()> {
    if window.label() != "main" {
        return Err("Shell commands require the main window".into());
    }
    Ok(())
}

fn build(command: &str, cwd: &str) -> std::process::Command {
    #[cfg(windows)]
    let mut c = {
        let mut c = crate::platform::command("cmd");
        c.arg("/C").arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let mut c = crate::platform::command(&shell);
        c.arg("-c").arg(command);
        // Its own group, so stopping takes the command's children with it
        std::os::unix::process::CommandExt::process_group(&mut c, 0);
        c
    };
    c.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    let _ = crate::platform::command("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).output();
    #[cfg(not(windows))]
    let _ = std::process::Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).output();
    let _ = child.kill();
}

#[tauri::command]
pub async fn start_shell(window: WebviewWindow, state: State<'_, AppState>, session: String, command: String, output: Channel<ShellEvent>) -> CmdResult<u32> {
    require_main(&window)?;
    let record = state.engine.store().get_session(&session).map_err(err)?;
    let cwd = record.worktree_path.or(record.repo_path).ok_or_else(|| "Session has no working directory".to_string())?;
    let mut child = build(&command, &cwd).spawn().map_err(err)?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let child = Arc::new(Mutex::new(child));
    let id = state.shells.next.fetch_add(1, Ordering::Relaxed);
    state.shells.running.lock().unwrap().insert(id, Arc::clone(&child));

    let sent = Arc::new(Mutex::new(0usize));
    let readers: Vec<_> = [stdout.map(|s| Box::new(s) as Box<dyn Read + Send>), stderr.map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
        .map(|mut stream| {
            let (output, sent) = (output.clone(), Arc::clone(&sent));
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                // A multi-byte character can straddle two reads
                let mut pending: Vec<u8> = Vec::new();
                while let Ok(n) = stream.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    pending.extend_from_slice(&buffer[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let chunk = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    let mut total = sent.lock().unwrap();
                    if *total >= OUTPUT_LIMIT {
                        continue;
                    }
                    *total += chunk.len();
                    if output.send(ShellEvent::Output { data: chunk }).is_err() {
                        break;
                    }
                }
            })
        })
        .collect();

    let shells = state.shells.running_handle();
    std::thread::spawn(move || {
        let code = loop {
            // Poll, so a stop can take the lock between checks
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(_) => break None,
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        for reader in readers {
            let _ = reader.join();
        }
        shells.lock().unwrap().remove(&id);
        let truncated = *sent.lock().unwrap() >= OUTPUT_LIMIT;
        let _ = output.send(ShellEvent::Exit { code, truncated });
    });
    Ok(id)
}

#[tauri::command]
pub async fn stop_shell(window: WebviewWindow, state: State<'_, AppState>, run: u32) -> CmdResult<()> {
    require_main(&window)?;
    let child = state.shells.running.lock().unwrap().get(&run).cloned();
    if let Some(child) = child {
        kill_tree(&mut child.lock().unwrap());
    }
    Ok(())
}
