//! 秘密の値（API キー）の保存先

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use crate::ProfileError;

pub trait SecretStore: Send + Sync {
    /// account は "<名前>/<変数名>"
    fn get(&self, account: &str) -> Result<String, ProfileError>;
    fn set(&self, account: &str, value: &str) -> Result<(), ProfileError>;
    fn delete(&self, account: &str) -> Result<(), ProfileError>;
}

/// macOS のキーチェーン（`security` コマンド経由）
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new("plyfold")
    }
}

fn err(account: &str, reason: impl Into<String>) -> ProfileError {
    ProfileError::Secret { account: account.into(), reason: reason.into() }
}

impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<String, ProfileError> {
        let out = Command::new("security")
            .args(["find-generic-password", "-s", &self.service, "-a", account, "-w"])
            .stderr(Stdio::null())
            .output()?;
        if !out.status.success() {
            return Err(err(account, plyfold_i18n::tr!("キーチェーンに登録されていません", "Not found in the keychain", "未在钥匙串中找到")));
        }
        let s = String::from_utf8(out.stdout).map_err(|_| err(account, plyfold_i18n::tr!("UTF-8 ではありません", "Not valid UTF-8", "不是有效的 UTF-8")))?;
        Ok(s.trim_end_matches('\n').to_string())
    }

    /// 値はコマンドライン引数に載せず、標準入力から渡す（`ps` に出さない）
    fn set(&self, account: &str, value: &str) -> Result<(), ProfileError> {
        use std::io::Write as _;
        // security -w を最後に置くと、パスワードを標準入力（確認を含め 2 回）から読む
        let mut child = Command::new("security")
            .args(["add-generic-password", "-U", "-s", &self.service, "-a", account, "-w"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        {
            let mut stdin = child.stdin.take().expect("piped");
            writeln!(stdin, "{value}")?;
            writeln!(stdin, "{value}")?;
        }
        if !child.wait()?.success() {
            return Err(err(account, plyfold_i18n::tr!("登録に失敗しました", "Could not save to the keychain", "保存到钥匙串失败")));
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), ProfileError> {
        let status = Command::new("security")
            .args(["delete-generic-password", "-s", &self.service, "-a", account])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(err(account, plyfold_i18n::tr!("削除に失敗しました（登録されていない可能性があります）", "Could not delete (it may not be in the keychain)", "删除失败（可能不在钥匙串中）")));
        }
        Ok(())
    }
}

/// テスト用
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl<const N: usize> From<[(&str, &str); N]> for MemoryStore {
    fn from(items: [(&str, &str); N]) -> Self {
        Self(Mutex::new(items.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()))
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<String, ProfileError> {
        self.0.lock().unwrap().get(account).cloned().ok_or_else(|| err(account, plyfold_i18n::tr!("登録されていません", "Not found", "未找到")))
    }
    fn set(&self, account: &str, value: &str) -> Result<(), ProfileError> {
        self.0.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), ProfileError> {
        self.0.lock().unwrap().remove(account).map(|_| ()).ok_or_else(|| err(account, plyfold_i18n::tr!("登録されていません", "Not found", "未找到")))
    }
}
