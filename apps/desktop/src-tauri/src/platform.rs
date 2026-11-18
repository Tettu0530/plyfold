//! The few things the app does differently per OS: showing a file in the file manager, opening a file, folder or
//! link with the default app, and naming the OS version for Settings → Info

use std::path::Path;

/// A command that runs without flashing a console window on Windows (the app has none of its own)
pub fn command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Select a file in Finder / File Explorer
pub fn reveal(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(path).spawn().map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        opener::reveal(path).map_err(std::io::Error::other)
    }
}

/// Open a folder, file or http(s) link with the default app
pub fn open(target: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(target).spawn().map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        opener::open(target).map_err(std::io::Error::other)
    }
}

/// The OS's name and version ("macOS", "26.1"), when it can be read
pub fn os_version() -> (&'static str, Option<String>) {
    #[cfg(target_os = "macos")]
    {
        let v = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        ("macOS", v)
    }
    #[cfg(windows)]
    {
        // "Microsoft Windows [Version 10.0.26100.1742]"
        let v = command("cmd").args(["/C", "ver"]).output().ok().and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            let start = s.find("Version ")? + "Version ".len();
            let end = s[start..].find(']')? + start;
            Some(s[start..end].trim().to_string())
        });
        ("Windows", v)
    }
    #[cfg(target_os = "linux")]
    {
        // PRETTY_NAME="Ubuntu 24.04.1 LTS" → ("Linux", "Ubuntu 24.04.1 LTS")
        let v = std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|s| s.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")).map(|v| v.trim().trim_matches('"').to_string()).filter(|v| !v.is_empty()));
        ("Linux", v)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        (std::env::consts::OS, None)
    }
}
