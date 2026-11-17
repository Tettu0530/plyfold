//! Storage in the macOS Keychain (via the `security` command)

use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};

const SERVICE: &str = "plyfold-probe";

fn account(profile: &str, var: &str) -> String {
    format!("{profile}/{var}")
}

pub fn get(profile: &str, var: &str) -> Result<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", &account(profile, var), "-w"])
        .stderr(Stdio::null())
        .output()
        .context("cannot run the security command")?;
    if !out.status.success() {
        bail!("{} is not in the Keychain; store it with `plyfold-probe keys set {profile} {var}`", account(profile, var));
    }
    Ok(String::from_utf8(out.stdout)?.trim_end_matches('\n').to_string())
}

/// The value is never a command-line argument; `security` prompts for it
pub fn set(profile: &str, var: &str) -> Result<()> {
    eprintln!("Enter the value for {} (twice, to confirm)", account(profile, var));
    let status = Command::new("security").args(["add-generic-password", "-U", "-s", SERVICE, "-a", &account(profile, var), "-w"]).status()?;
    if !status.success() {
        bail!("failed to store the key");
    }
    Ok(())
}

pub fn delete(profile: &str, var: &str) -> Result<()> {
    let status = Command::new("security").args(["delete-generic-password", "-s", SERVICE, "-a", &account(profile, var)]).stdout(Stdio::null()).status()?;
    if !status.success() {
        bail!("failed to delete the key (it may not be stored)");
    }
    Ok(())
}
