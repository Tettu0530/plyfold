//! Where secret values (API keys) are stored

use std::collections::HashMap;
use std::sync::Mutex;

use crate::ProfileError;

pub trait SecretStore: Send + Sync {
    /// account is "<name>/<var>"
    fn get(&self, account: &str) -> Result<String, ProfileError>;
    fn set(&self, account: &str, value: &str) -> Result<(), ProfileError>;
    fn delete(&self, account: &str) -> Result<(), ProfileError>;
}

/// The OS's credential store: the macOS Keychain (via the `security` command) or the Windows Credential Manager.
/// Entries are keyed by a service name ("plyfold") and an account ("<profile>/<VARIABLE>")
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

fn not_found(account: &str) -> ProfileError {
    err(account, plyfold_i18n::tr!("キーチェーンに登録されていません", "Not found in the keychain", "未在钥匙串中找到"))
}

fn save_failed(account: &str) -> ProfileError {
    err(account, plyfold_i18n::tr!("登録に失敗しました", "Could not save to the keychain", "保存到钥匙串失败"))
}

fn delete_failed(account: &str) -> ProfileError {
    err(
        account,
        plyfold_i18n::tr!(
            "削除に失敗しました（登録されていない可能性があります）",
            "Could not delete (it may not be in the keychain)",
            "删除失败（可能不在钥匙串中）"
        ),
    )
}

#[cfg(target_os = "macos")]
impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<String, ProfileError> {
        use std::process::{Command, Stdio};
        let out = Command::new("security").args(["find-generic-password", "-s", &self.service, "-a", account, "-w"]).stderr(Stdio::null()).output()?;
        if !out.status.success() {
            return Err(not_found(account));
        }
        let s = String::from_utf8(out.stdout).map_err(|_| err(account, plyfold_i18n::tr!("UTF-8 ではありません", "Not valid UTF-8", "不是有效的 UTF-8")))?;
        Ok(s.trim_end_matches('\n').to_string())
    }

    /// The value goes through stdin, not command-line arguments (so it never shows up in `ps`)
    fn set(&self, account: &str, value: &str) -> Result<(), ProfileError> {
        use std::io::Write as _;
        use std::process::{Command, Stdio};
        // With -w last, security reads the password from stdin (twice, including confirmation)
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
            return Err(save_failed(account));
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), ProfileError> {
        use std::process::{Command, Stdio};
        let status = Command::new("security")
            .args(["delete-generic-password", "-s", &self.service, "-a", account])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(delete_failed(account));
        }
        Ok(())
    }
}

/// The Windows Credential Manager (generic credentials), or on Linux the Secret Service (GNOME Keyring, KWallet), through
/// the keyring crate
#[cfg(any(windows, target_os = "linux"))]
impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<String, ProfileError> {
        let entry = keyring::Entry::new(&self.service, account).map_err(|_| not_found(account))?;
        entry.get_password().map_err(|_| not_found(account))
    }

    fn set(&self, account: &str, value: &str) -> Result<(), ProfileError> {
        let entry = keyring::Entry::new(&self.service, account).map_err(|e| unavailable_or(account, &e))?;
        entry.set_password(value).map_err(|e| unavailable_or(account, &e))
    }

    fn delete(&self, account: &str) -> Result<(), ProfileError> {
        let entry = keyring::Entry::new(&self.service, account).map_err(|_| delete_failed(account))?;
        entry.delete_credential().map_err(|_| delete_failed(account))
    }
}

/// Saving failed: on Linux, say when it is because no Secret Service is running (a desktop without GNOME Keyring or
/// KWallet), since that is the usual reason and the fix is outside Plyfold
#[cfg(any(windows, target_os = "linux"))]
fn unavailable_or(account: &str, e: &keyring::Error) -> ProfileError {
    if cfg!(target_os = "linux") && matches!(e, keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)) {
        return err(
            account,
            plyfold_i18n::tr!(
                "キーを保存できません。GNOME キーリングや KWallet などの Secret Service が動いている必要があります",
                "Cannot save the key: a Secret Service (GNOME Keyring, KWallet) needs to be running",
                "无法保存密钥：需要运行 Secret Service（GNOME 密钥环、KWallet 等）"
            ),
        );
    }
    save_failed(account)
}

/// Other systems have no supported credential store yet
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<String, ProfileError> {
        Err(not_found(account))
    }
    fn set(&self, account: &str, _value: &str) -> Result<(), ProfileError> {
        Err(save_failed(account))
    }
    fn delete(&self, account: &str) -> Result<(), ProfileError> {
        Err(delete_failed(account))
    }
}

/// For tests
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
