//! macOS キーチェーンへの保存（`security` コマンド経由）

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
        .context("security コマンドを実行できません")?;
    if !out.status.success() {
        bail!(
            "キーチェーンに {} がありません。`plyfold-probe keys set {profile} {var}` で登録してください",
            account(profile, var)
        );
    }
    Ok(String::from_utf8(out.stdout)?.trim_end_matches('\n').to_string())
}

/// 値はコマンドライン引数に載せず、security の対話入力で受け取る
pub fn set(profile: &str, var: &str) -> Result<()> {
    eprintln!("{} の値を入力してください（確認のため 2 回）", account(profile, var));
    let status = Command::new("security")
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", &account(profile, var), "-w"])
        .status()?;
    if !status.success() {
        bail!("登録に失敗しました");
    }
    Ok(())
}

pub fn delete(profile: &str, var: &str) -> Result<()> {
    let status = Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", &account(profile, var)])
        .stdout(Stdio::null())
        .status()?;
    if !status.success() {
        bail!("削除に失敗しました（登録されていない可能性があります）");
    }
    Ok(())
}
