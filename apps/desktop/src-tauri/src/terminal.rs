use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{State, Webview, ipc::Channel};

use crate::{AppState, CmdResult, err};

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    sessions: Arc<Mutex<HashMap<u32, Terminal>>>,
}

struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// The "session" a terminal opened from the app header names when no session's folder applies: the home folder
const HOME_TERMINAL: &str = "~";

fn home_dir() -> CmdResult<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "The home folder is not known".to_string())
}

fn require_main(window: &Webview) -> CmdResult<()> {
    if window.label() != "main" {
        return Err("Terminal access requires the main window".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn start_terminal(
    window: Webview,
    state: State<'_, AppState>,
    session: String,
    rows: u16,
    cols: u16,
    output: Channel<Option<Vec<u8>>>,
) -> CmdResult<u32> {
    require_main(&window)?;
    // A session's worktree, else its folder; with neither (an everyday conversation), the home folder
    let cwd = if session == HOME_TERMINAL {
        home_dir()?
    } else {
        let record = state.engine.store().get_session(&session).map_err(err)?;
        match record.worktree_path.or(record.repo_path) {
            Some(dir) => dir,
            None => home_dir()?,
        }
    };
    let pair = native_pty_system().openpty(size(rows, cols)).map_err(err)?;
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let mut command = CommandBuilder::new_default_prog();
    command.cwd(Path::new(&cwd));
    command.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(command).map_err(err)?;
    drop(pair.slave);
    let terminal = Terminal { master: pair.master, writer: Arc::new(Mutex::new(writer)), killer: child.clone_killer() };
    let id = state.terminals.next.fetch_add(1, Ordering::Relaxed);
    state.terminals.sessions.lock().unwrap().insert(id, terminal);

    let sessions = Arc::downgrade(&state.terminals.sessions);
    std::thread::spawn(move || {
        let mut buffer = [0; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if output.send(Some(buffer[..count].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if let Some(sessions) = sessions.upgrade() {
            sessions.lock().unwrap().remove(&id);
        }
        drop(reader);
        let _ = child.wait();
        let _ = output.send(None);
    });
    Ok(id)
}

#[tauri::command]
pub async fn write_terminal(window: Webview, state: State<'_, AppState>, terminal: u32, data: Vec<u8>) -> CmdResult<()> {
    require_main(&window)?;
    let writer = state.terminals.sessions.lock().unwrap().get(&terminal).map(|session| Arc::clone(&session.writer));
    if let Some(writer) = writer {
        tauri::async_runtime::spawn_blocking(move || writer.lock().unwrap().write_all(&data)).await.map_err(err)?.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_terminal(window: Webview, state: State<'_, AppState>, terminal: u32, rows: u16, cols: u16) -> CmdResult<()> {
    require_main(&window)?;
    if let Some(session) = state.terminals.sessions.lock().unwrap().get(&terminal) {
        session.master.resize(size(rows, cols)).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_terminal(window: Webview, state: State<'_, AppState>, terminal: u32) -> CmdResult<()> {
    require_main(&window)?;
    state.terminals.sessions.lock().unwrap().remove(&terminal);
    Ok(())
}
