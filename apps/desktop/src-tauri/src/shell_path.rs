//! Apps started from Finder or the Dock get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the agent CLIs and the
//! tools they need (npx, node, git, gh, opencode) would not be found. At launch, read the PATH your login shell sets up
//! and put it in front of the inherited one.
//!
//! The shell runs once, without input, with a time limit; anything it prints besides the PATH (rc file messages) is
//! ignored. If it fails, common install locations are added instead

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARK: &str = "__PLYFOLD_PATH__";
const TIMEOUT: Duration = Duration::from_secs(5);

/// The PATH printed by the user's login shell (interactive, so version managers set up in .zshrc are included)
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
    let mut child = Command::new(&shell).args(["-ilc", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let started = Instant::now();
    loop {
        if child.try_wait().ok()?.is_some() {
            break;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    between_marks(&out)
}

fn between_marks(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let len = out[start..].find(MARK)?;
    let path = out[start..start + len].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// `first` followed by the entries of `rest` it doesn't already have (order kept, empty entries dropped)
fn merge(first: &str, rest: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    first.split(':').chain(rest.split(':')).filter(|p| !p.is_empty() && seen.insert(*p)).collect::<Vec<_>>().join(":")
}

/// Call before anything else starts (setting environment variables is only safe while the process is single-threaded)
pub fn adopt_login_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let fallback = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", &format!("{home}/.cargo/bin"), &format!("{home}/.local/bin")].join(":");
    let shell = login_shell_path().unwrap_or(fallback);
    let path = merge(&shell, &current);
    // SAFETY: called first thing in main, before Tauri or any other thread starts
    unsafe { std::env::set_var("PATH", path) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_path_between_the_marks() {
        let out = format!("Welcome!\n{MARK}/opt/homebrew/bin:/usr/bin{MARK}\nbye");
        assert_eq!(between_marks(&out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(between_marks("no marks"), None);
        assert_eq!(between_marks(&format!("{MARK}{MARK}")), None);
    }

    #[test]
    fn merges_without_duplicates() {
        assert_eq!(merge("/a:/b", "/usr/bin:/b::/c"), "/a:/b:/usr/bin:/c");
    }

    #[test]
    fn the_login_shell_answers() {
        // zsh is on every Mac; its PATH always has /usr/bin
        assert!(login_shell_path().is_some_and(|p| p.split(':').any(|e| e == "/usr/bin")));
    }
}
