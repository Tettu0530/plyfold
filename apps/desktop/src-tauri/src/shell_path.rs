//! Apps started from Finder, the Dock, or a Linux desktop launcher get a minimal PATH, so the agent CLIs and the
//! tools they need (npx, node, git, gh, opencode) would not be found. At launch, read the PATH the login shell sets up
//! and put it in front of the inherited one.
//!
//! The shell runs once, without input, with a time limit; anything it prints besides the PATH (rc file messages) is
//! ignored. If it fails, common install locations are added instead. On Linux the shell is `$SHELL`, then the login
//! shell in `/etc/passwd`, then `/bin/bash`. A PATH kept in the state directory is used for this start even when it is
//! old, so the start does not wait on the shell. The shell is read again in the background and the file is written for
//! the next start. A shell that did not answer is not kept. Directories that exist are added on every launch, so a CLI
//! installed into one of them is found on this start. Homebrew's paths stay a macOS fallback.

// Only Unix-like systems need this; on Windows the helpers below are unused
#![cfg_attr(windows, allow(unused_imports, dead_code))]

use std::io::Read;
#[cfg(any(test, target_os = "linux"))]
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(test)]
use std::time::SystemTime;
use std::time::{Duration, Instant};

const MARK: &str = "__PLYFOLD_PATH__";
const TIMEOUT: Duration = Duration::from_secs(5);
/// A login shell's PATH is a short line. Anything larger is not one, and is not worth reading at startup.
#[cfg(any(test, target_os = "linux"))]
const CACHE_MAX_BYTES: u64 = 64 * 1024;

#[cfg(not(windows))]
/// The PATH printed by the user's login shell (interactive, so version managers set up in .zshrc or .bashrc are included)
fn login_shell_path() -> Option<String> {
    let from_env = std::env::var("SHELL").ok();
    let from_passwd = passwd_shell();
    let shell = choose_shell(from_env.as_deref(), from_passwd.as_deref());
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

/// `$SHELL` when it is a real shell, otherwise the passwd entry, otherwise bash on Linux and zsh elsewhere
fn choose_shell(from_env: Option<&str>, from_passwd: Option<&str>) -> String {
    if let Some(shell) = from_env.filter(|s| usable_shell(s)) {
        return shell.to_string();
    }
    if let Some(shell) = from_passwd.filter(|s| usable_shell(s)) {
        return shell.to_string();
    }
    if cfg!(target_os = "linux") { "/bin/bash".to_string() } else { "/bin/zsh".to_string() }
}

fn usable_shell(shell: &str) -> bool {
    if !shell.starts_with('/') || shell.contains('\n') || shell.contains('\0') {
        return false;
    }
    !matches!(shell, "/usr/sbin/nologin" | "/sbin/nologin" | "/bin/false" | "/usr/bin/false")
}

/// The login shell for this process's uid. Linux desktop launches sometimes have no `SHELL`; other systems keep the
/// compiled-in default (`/bin/zsh` on macOS) when `SHELL` is unset.
fn passwd_shell() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let uid = uid_from_status(&std::fs::read_to_string("/proc/self/status").ok()?)?;
        shell_in_passwd(&std::fs::read_to_string("/etc/passwd").ok()?, uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(any(test, target_os = "linux"))]
fn uid_from_status(status: &str) -> Option<u32> {
    let line = status.lines().find(|l| l.starts_with("Uid:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// The shell field of the first `/etc/passwd` record with this uid, when it is a shell that can be executed
#[cfg(any(test, target_os = "linux"))]
fn shell_in_passwd(text: &str, uid: u32) -> Option<String> {
    for line in text.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 7 {
            continue;
        }
        let Ok(id) = fields[2].parse::<u32>() else { continue };
        if id != uid {
            continue;
        }
        return usable_shell(fields[6]).then(|| fields[6].to_string());
    }
    None
}

#[cfg_attr(windows, allow(dead_code))]
fn between_marks(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let len = out[start..].find(MARK)?;
    let path = out[start..start + len].trim();
    (!path.is_empty()).then(|| path.to_string())
}

#[cfg_attr(windows, allow(dead_code))]
/// `first` followed by the entries of `rest` it doesn't already have (order kept, empty entries dropped)
fn merge(first: &str, rest: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    first.split(':').chain(rest.split(':')).filter(|p| !p.is_empty() && seen.insert(*p)).collect::<Vec<_>>().join(":")
}

#[cfg(target_os = "linux")]
fn cache_file() -> PathBuf {
    // The installed app and a development build look up the same CLIs, so this stays in the shared state directory
    plyfold_profile::default_state_dir().join("login-path")
}

/// A usable cache for this start. `refresh` means the login shell is read after PATH is published, and the file is
/// written for the next start. The age of the file does not matter: a start never waits on the shell when a PATH is
/// already on disk.
#[cfg(any(test, target_os = "linux"))]
struct CachedStart {
    path: String,
    refresh: bool,
}

#[cfg(any(test, target_os = "linux"))]
fn cached_start(path: &Path) -> Option<CachedStart> {
    let path = read_cache(path)?;
    Some(CachedStart { path, refresh: true })
}

/// A single PATH line. Empty, multi-line, or without a directory separator is not a PATH we should adopt.
#[cfg(any(test, target_os = "linux"))]
fn accepted_path(text: &str) -> Option<String> {
    let path = text.trim();
    if path.is_empty() || path.contains('\n') || path.contains('\0') || !path.contains('/') {
        return None;
    }
    Some(path.to_string())
}

/// The cached PATH, when the file is a regular file and small enough. Age is ignored: an old file is still this
/// start's PATH, and a later start gets whatever the background read wrote.
/// A symlink is ignored: the state directory is ours, and a link there must not point PATH somewhere else.
#[cfg(any(test, target_os = "linux"))]
fn read_cache(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    if meta.len() > CACHE_MAX_BYTES {
        return None;
    }
    accepted_path(&std::fs::read_to_string(path).ok()?)
}

#[cfg(any(test, target_os = "linux"))]
fn write_cache(dest: &Path, shell_path: &str) -> std::io::Result<()> {
    let Some(path) = accepted_path(shell_path) else {
        return Err(std::io::Error::other("not a path"));
    };
    let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Err(std::io::Error::other("no directory"));
    };
    std::fs::create_dir_all(parent)?;
    let tmp = dest.with_file_name(format!(".login-path.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &path)?;
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_candidates(home: &str) -> Vec<String> {
    let mut out = Vec::with_capacity(6);
    if !home.is_empty() {
        out.push(format!("{home}/.local/bin"));
        out.push(format!("{home}/.cargo/bin"));
    }
    out.push("/usr/local/bin".into());
    out.push("/snap/bin".into());
    if !home.is_empty() {
        out.push(format!("{home}/.bun/bin"));
        out.push(format!("{home}/.volta/bin"));
    }
    out
}

#[cfg(target_os = "linux")]
fn linux_fallback(home: &str) -> String {
    join_present(&linux_candidates(home), |p| std::path::Path::new(p).is_dir())
}

#[cfg(any(test, target_os = "linux"))]
fn join_present(candidates: &[String], present: impl Fn(&str) -> bool) -> String {
    candidates.iter().filter(|p| present(p)).map(String::as_str).collect::<Vec<_>>().join(":")
}

#[cfg(not(target_os = "linux"))]
fn macos_fallback(home: &str) -> String {
    ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", &format!("{home}/.cargo/bin"), &format!("{home}/.local/bin")].join(":")
}

/// The PATH to put in front, and whether Linux should refresh the cache after this start.
#[cfg(not(windows))]
fn shell_path(home: &str) -> (String, bool) {
    #[cfg(target_os = "linux")]
    {
        let dest = cache_file();
        let extra = linux_fallback(home);
        if let Some(hit) = cached_start(&dest) {
            return (merge(&hit.path, &extra), hit.refresh);
        }
        // Nothing usable on disk. This first start is the one that waits; the answer is kept for the next one.
        let read = login_shell_path().unwrap_or_default();
        if !read.is_empty() {
            let _ = write_cache(&dest, &read);
        }
        let path = if read.is_empty() { extra } else { merge(&read, &extra) };
        (path, false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        (login_shell_path().unwrap_or_else(|| macos_fallback(home)), false)
    }
}

/// Read the login shell after startup and write the cache for the next start. A shell that does not answer leaves the
/// file as it is.
#[cfg(target_os = "linux")]
fn refresh_cached_path() {
    let dest = cache_file();
    if let Some(path) = login_shell_path() {
        let _ = write_cache(&dest, &path);
    }
}

#[cfg(not(windows))]
fn schedule_refresh(refresh: bool) {
    // set_var is unsound once another thread is running, so this is called only after PATH is published.
    #[cfg(target_os = "linux")]
    if refresh {
        let _ = std::thread::spawn(refresh_cached_path);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = refresh;
}

/// Call before anything else starts (setting environment variables is only safe while the process is single-threaded).
/// Windows apps already get the user's PATH, so there is nothing to do there
#[cfg(windows)]
pub fn adopt_login_path() {}

#[cfg(not(windows))]
/// Call before anything else starts (setting environment variables is only safe while the process is single-threaded)
pub fn adopt_login_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let (front, refresh) = shell_path(&home);
    // SAFETY: called first thing in main, before Tauri or any other thread starts. The refresh thread is spawned
    // after this, so it does not race with set_var.
    unsafe { std::env::set_var("PATH", merge(&front, &current)) };
    schedule_refresh(refresh);
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
    fn the_env_shell_wins_and_a_relative_or_nologin_shell_does_not() {
        assert_eq!(choose_shell(Some("/bin/fish"), Some("/bin/bash")), "/bin/fish");
        assert_eq!(choose_shell(Some("bash"), Some("/bin/fish")), "/bin/fish");
        let fallback = if cfg!(target_os = "linux") { "/bin/bash" } else { "/bin/zsh" };
        assert_eq!(choose_shell(None, None), fallback);
        assert_eq!(choose_shell(Some("/usr/sbin/nologin"), None), fallback);
        assert_eq!(choose_shell(Some("/bin/false"), Some("/bin/zsh")), "/bin/zsh");
    }

    #[test]
    fn the_passwd_shell_is_the_record_for_that_uid() {
        let text = "\
root:x:0:0:root:/root:/bin/bash
# not a record
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
ada:x:1000:1000:Ada:/home/ada:/bin/zsh
short:x:1001
";
        assert_eq!(shell_in_passwd(text, 1000).as_deref(), Some("/bin/zsh"));
        assert_eq!(shell_in_passwd(text, 0).as_deref(), Some("/bin/bash"));
        assert_eq!(shell_in_passwd(text, 65534), None);
        assert_eq!(shell_in_passwd(text, 1001), None);
        assert_eq!(shell_in_passwd(text, 9), None);
    }

    #[test]
    fn the_uid_is_the_first_field_of_the_status_line() {
        let status = "Name:\tplyfold\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n";
        assert_eq!(uid_from_status(status), Some(1000));
        assert_eq!(uid_from_status("Uid:\tnope\n"), None);
        assert_eq!(uid_from_status(""), None);
    }

    #[test]
    fn a_path_line_has_one_line_and_a_directory() {
        assert_eq!(accepted_path("  /usr/bin:/bin  \n").as_deref(), Some("/usr/bin:/bin"));
        assert_eq!(accepted_path(""), None);
        assert_eq!(accepted_path("relative"), None);
        assert_eq!(accepted_path("/usr/bin\n/tmp"), None);
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-shell-path-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_cache_roundtrips_and_rejects_a_symlink_and_a_large_file() {
        let dir = tmp("cache");
        let dest = dir.join("login-path");
        write_cache(&dest, "  /usr/bin:/home/t/.local/bin \n").unwrap();
        assert_eq!(read_cache(&dest).as_deref(), Some("/usr/bin:/home/t/.local/bin"));
        assert!(write_cache(&dest, "relative").is_err());
        // The rejected write must not replace a good cache
        assert_eq!(read_cache(&dest).as_deref(), Some("/usr/bin:/home/t/.local/bin"));

        let big = format!("/usr/bin:{}", "a".repeat(CACHE_MAX_BYTES as usize));
        std::fs::write(&dest, &big).unwrap();
        assert_eq!(read_cache(&dest), None);

        #[cfg(unix)]
        {
            let real = dir.join("real");
            std::fs::write(&real, "/usr/bin").unwrap();
            let link = dir.join("linked");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(read_cache(&link), None);
        }
    }

    #[test]
    fn a_stale_cache_is_used_and_a_refresh_is_scheduled() {
        let dir = tmp("stale");
        let dest = dir.join("login-path");
        let kept = "/home/t/.nvm/versions/node/v20/bin:/usr/bin";
        write_cache(&dest, kept).unwrap();
        let file = std::fs::File::options().write(true).open(&dest).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(10)).unwrap();
        drop(file);

        let hit = cached_start(&dest).unwrap();
        assert_eq!(hit.path, kept);
        // adopt_login_path spawns the login-shell read only when this is set, and only after PATH is published
        assert!(hit.refresh);
    }

    #[test]
    fn present_directories_keep_their_order() {
        let candidates = ["/a", "/b", "/c"].map(str::to_string);
        let joined = join_present(&candidates, |p| p != "/b");
        assert_eq!(joined, "/a:/c");
        assert_eq!(join_present(&candidates, |_| false), "");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_candidates_follow_the_home_then_the_system_dirs() {
        let home = "/home/t";
        assert_eq!(
            linux_candidates(home),
            vec![
                format!("{home}/.local/bin"),
                format!("{home}/.cargo/bin"),
                "/usr/local/bin".to_string(),
                "/snap/bin".to_string(),
                format!("{home}/.bun/bin"),
                format!("{home}/.volta/bin"),
            ]
        );
        assert_eq!(linux_candidates(""), vec!["/usr/local/bin".to_string(), "/snap/bin".to_string()]);
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn the_macos_fallback_lists_homebrew_and_the_user_bin_dirs() {
        assert_eq!(macos_fallback("/Users/t"), "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/t/.cargo/bin:/Users/t/.local/bin");
    }

    #[test]
    #[cfg(unix)]
    fn the_login_shell_answers() {
        // /usr/bin is on the PATH of every login shell we ship for
        assert!(login_shell_path().is_some_and(|p| p.split(':').any(|e| e == "/usr/bin")));
    }
}
