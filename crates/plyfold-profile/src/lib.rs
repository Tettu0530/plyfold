//! プロファイル = エージェント（CLI）× 認証情報 × 設定ディレクトリ
//!
//! 1 つの CLI に複数のキーを持たせるのが前提条件。プロファイルを分けると:
//! - キーはキーチェーンから取り出して、起動するときだけ環境変数で渡す
//! - 親プロセスのキー系の環境変数は引き継がない（混ざらないようにする）
//! - `isolate` なら CLI の設定ディレクトリをプロファイル専用にする（普段の設定に触らない）

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use plyfold_acp::SpawnSpec;
use serde::{Deserialize, Serialize};

pub mod edit;
pub mod secrets;

pub use secrets::{KeychainStore, MemoryStore, SecretStore};

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("'{0}' はプロファイルにもエージェントにもありません")]
    UnknownTarget(String),
    #[error("プロファイル '{profile}' のエージェント '{agent}' が定義されていません")]
    UnknownAgent { profile: String, agent: String },
    #[error("エージェント '{0}' は config_dir_env がないので isolate できません")]
    CannotIsolate(String),
    #[error("{0} のパスはプロファイルのディレクトリの中に限ります: {1}")]
    PathEscape(&'static str, String),
    #[error("キーの取得元 '{0}' は不明です（keychain / keychain:<名前>/<変数名> / env:VAR）")]
    BadKeySource(String),
    #[error("秘密の値を取得できません（{account}）: {reason}")]
    Secret { account: String, reason: String },
    #[error("設定ファイルを読めません: {0}")]
    Io(#[from] std::io::Error),
    #[error("設定ファイルの形式が不正です: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("{0}")]
    Form(String),
}

/// ACP で起動するエージェント
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentDef {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// プロファイルを分けるときに差し替える、設定ディレクトリの環境変数
    pub config_dir_env: Option<String>,
    /// 既定プロファイル以外では親から引き継がない環境変数
    #[serde(default)]
    pub key_envs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ProfileDef {
    pub agent: String,
    /// 画面に出す名前
    pub label: Option<String>,
    #[serde(default)]
    pub isolate: bool,
    /// 環境変数名 → 取得元（"keychain" / "keychain:<名前>/<変数名>" / "env:VAR"）
    #[serde(default)]
    pub keys: BTreeMap<String, String>,
    /// 値の中の `{profile_dir}` はプロファイルのディレクトリに置き換わる
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// isolate したディレクトリに置くファイル（相対パス → 中身）
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// isolate したディレクトリに張るシンボリックリンク（相対パス → リンク先。`~/` 可）。
    /// ログイン情報は複製するとトークンの更新でぶつかるので、リンクで共有する
    #[serde(default)]
    pub links: BTreeMap<String, String>,
    /// session/new の直後に切り替えるモード
    pub default_mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Config {
    #[serde(default)]
    pub agents: BTreeMap<String, AgentDef>,
    #[serde(default)]
    pub profiles: BTreeMap<String, ProfileDef>,
}

/// 起動に必要なものを解決したもの
#[derive(Debug, Clone)]
pub struct Resolved {
    pub profile: String,
    pub agent: String,
    pub label: String,
    pub spawn: SpawnSpec,
    pub default_mode: Option<String>,
    /// 表示用の環境変数の要約（値は伏せる）
    pub env_summary: Vec<String>,
}

pub fn builtin_agents() -> BTreeMap<String, AgentDef> {
    let a = |command: &str, args: &[&str], config_dir_env: Option<&str>, key_envs: &[&str]| AgentDef {
        command: command.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: BTreeMap::new(),
        config_dir_env: config_dir_env.map(str::to_string),
        key_envs: key_envs.iter().map(|s| s.to_string()).collect(),
    };
    BTreeMap::from([
        (
            "claude".into(),
            a(
                "npx",
                &["-y", "@agentclientprotocol/claude-agent-acp@0.107.0"],
                Some("CLAUDE_CONFIG_DIR"),
                &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"],
            ),
        ),
        (
            "codex".into(),
            a("npx", &["-y", "@agentclientprotocol/codex-acp@2.6.0"], Some("CODEX_HOME"), &["OPENAI_API_KEY", "CODEX_API_KEY"]),
        ),
        (
            "opencode".into(),
            a("opencode", &["acp"], Some("XDG_DATA_HOME"), &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]),
        ),
        (
            "gemini".into(),
            a("npx", &["-y", "@google/gemini-cli@0.68.0", "--experimental-acp"], None, &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
        ),
        ("mock".into(), a("plyfold-mock-agent", &[], None, &[])),
    ])
}

impl Config {
    /// 組み込みのエージェント定義の上に、ファイルの内容を重ねる
    pub fn from_toml(text: &str) -> Result<Self, ProfileError> {
        let file: Config = toml::from_str(text)?;
        let mut cfg = Config { agents: builtin_agents(), profiles: BTreeMap::new() };
        cfg.agents.extend(file.agents);
        cfg.profiles.extend(file.profiles);
        Ok(cfg)
    }

    /// ファイルがなければ組み込みの定義だけにする
    pub fn load(path: &Path) -> Result<Self, ProfileError> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::from_toml(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::from_toml(""),
            Err(e) => Err(e.into()),
        }
    }

    /// `target` はプロファイル名かエージェント名（エージェント名なら、何も上書きしない既定プロファイル）
    pub fn resolve(
        &self,
        target: &str,
        state_dir: &Path,
        cwd: &Path,
        secrets: &dyn SecretStore,
    ) -> Result<Resolved, ProfileError> {
        let profile = match self.profiles.get(target) {
            Some(p) => p.clone(),
            None if self.agents.contains_key(target) => ProfileDef { agent: target.into(), ..Default::default() },
            None => return Err(ProfileError::UnknownTarget(target.into())),
        };
        let agent = self
            .agents
            .get(&profile.agent)
            .ok_or_else(|| ProfileError::UnknownAgent { profile: target.into(), agent: profile.agent.clone() })?;

        let is_default = profile.keys.is_empty() && !profile.isolate && profile.files.is_empty() && profile.links.is_empty();
        let mut env_set: Vec<(String, String)> = agent.env.clone().into_iter().collect();
        let env_remove = if is_default { Vec::new() } else { agent.key_envs.clone() };
        let mut env_summary = Vec::new();
        let mut secret_values = Vec::new();

        let profile_dir = state_dir.join("profiles").join(target);
        if profile.isolate {
            let var = agent.config_dir_env.as_ref().ok_or_else(|| ProfileError::CannotIsolate(profile.agent.clone()))?;
            std::fs::create_dir_all(&profile_dir)?;
            for (rel, content) in &profile.files {
                let p = profile_dir.join(safe_rel("files", rel)?);
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(p, content)?;
            }
            for (rel, dest) in &profile.links {
                let link = profile_dir.join(safe_rel("links", rel)?);
                let dest = expand_home(dest);
                if link.symlink_metadata().is_ok() {
                    std::fs::remove_file(&link)?;
                }
                std::os::unix::fs::symlink(dest, &link)?;
            }
            env_summary.push(format!("{var}={}", profile_dir.display()));
            env_set.push((var.clone(), profile_dir.display().to_string()));
        }

        for (var, source) in &profile.keys {
            let value = if source == "keychain" {
                secrets.get(&format!("{target}/{var}"))?
            } else if let Some(account) = source.strip_prefix("keychain:") {
                secrets.get(account)?
            } else if let Some(other) = source.strip_prefix("env:") {
                std::env::var(other).map_err(|_| ProfileError::Secret {
                    account: format!("env:{other}"),
                    reason: "環境変数がありません".into(),
                })?
            } else {
                return Err(ProfileError::BadKeySource(source.clone()));
            };
            env_summary.push(format!("{var}=***（{} 文字）", value.chars().count()));
            secret_values.push(value.clone());
            env_set.push((var.clone(), value));
        }

        for (k, v) in &profile.env {
            let v = v.replace("{profile_dir}", &profile_dir.display().to_string());
            env_summary.push(format!("{k}={v}"));
            env_set.push((k.clone(), v));
        }

        Ok(Resolved {
            profile: target.into(),
            agent: profile.agent.clone(),
            label: profile.label.clone().unwrap_or_else(|| target.to_string()),
            spawn: SpawnSpec {
                command: agent.command.clone(),
                args: agent.args.clone(),
                cwd: cwd.to_path_buf(),
                env_set,
                env_remove,
                secrets: secret_values,
            },
            default_mode: profile.default_mode.clone(),
            env_summary,
        })
    }
}

fn safe_rel(kind: &'static str, rel: &str) -> Result<PathBuf, ProfileError> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(ProfileError::PathEscape(kind, rel.into()));
    }
    Ok(p.to_path_buf())
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest),
        None => PathBuf::from(p),
    }
}

/// macOS の既定の状態ディレクトリ
pub fn default_state_dir() -> PathBuf {
    expand_home("~/Library/Application Support/plyfold")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-profile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const TOML: &str = r#"
[profiles.claude-proxy]
agent = "claude"
label = "Claude（プロキシ）"
isolate = true
keys = { ANTHROPIC_AUTH_TOKEN = "keychain:proxy/KEY" }
env = { ANTHROPIC_BASE_URL = "https://example.invalid", HOME_HINT = "{profile_dir}/x" }
files = { ".claude.json" = '{ "hasCompletedOnboarding": true }' }

[profiles.codex-own]
agent = "codex"
isolate = true
keys = { OPENAI_API_KEY = "keychain" }
links = { "auth.json" = "/nonexistent/auth.json" }
"#;

    #[test]
    fn builtin_agent_as_default_profile() {
        let cfg = Config::from_toml("").unwrap();
        let r = cfg.resolve("claude", &tmp("d"), Path::new("/w"), &MemoryStore::default()).unwrap();
        assert!(r.spawn.env_remove.is_empty(), "既定プロファイルは何も外さない");
        assert!(r.spawn.env_set.is_empty());
        assert_eq!(r.spawn.cwd, Path::new("/w"));
    }

    #[test]
    fn isolated_profile_with_shared_key() {
        let state = tmp("iso");
        let cfg = Config::from_toml(TOML).unwrap();
        let store = MemoryStore::from([("proxy/KEY", "sk-test-1234567890")]);
        let r = cfg.resolve("claude-proxy", &state, Path::new("/w"), &store).unwrap();
        let env: BTreeMap<_, _> = r.spawn.env_set.iter().cloned().collect();
        let dir = state.join("profiles/claude-proxy");
        assert_eq!(env["CLAUDE_CONFIG_DIR"], dir.display().to_string());
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-test-1234567890");
        assert_eq!(env["HOME_HINT"], format!("{}/x", dir.display()));
        assert!(r.spawn.env_remove.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert_eq!(r.spawn.secrets, vec!["sk-test-1234567890".to_string()]);
        assert!(dir.join(".claude.json").exists());
        assert!(r.env_summary.iter().all(|s| !s.contains("sk-test")));
        assert_eq!(r.label, "Claude（プロキシ）");
    }

    #[test]
    fn per_profile_keychain_account_and_links() {
        let state = tmp("link");
        let cfg = Config::from_toml(TOML).unwrap();
        let store = MemoryStore::from([("codex-own/OPENAI_API_KEY", "sk-own-abcdefgh")]);
        cfg.resolve("codex-own", &state, Path::new("/w"), &store).unwrap();
        let link = state.join("profiles/codex-own/auth.json");
        assert_eq!(std::fs::read_link(link).unwrap(), Path::new("/nonexistent/auth.json"));
    }

    #[test]
    fn missing_secret_is_an_error() {
        let cfg = Config::from_toml(TOML).unwrap();
        let err = cfg.resolve("codex-own", &tmp("miss"), Path::new("/w"), &MemoryStore::default()).unwrap_err();
        assert!(matches!(err, ProfileError::Secret { .. }));
    }

    #[test]
    fn rejects_path_escape() {
        let cfg = Config::from_toml(
            r#"
[profiles.bad]
agent = "claude"
isolate = true
files = { "../evil" = "x" }
"#,
        )
        .unwrap();
        let err = cfg.resolve("bad", &tmp("esc"), Path::new("/w"), &MemoryStore::default()).unwrap_err();
        assert!(matches!(err, ProfileError::PathEscape("files", _)));
    }

    #[test]
    fn unknown_target() {
        let cfg = Config::from_toml("").unwrap();
        assert!(matches!(
            cfg.resolve("nope", &tmp("u"), Path::new("/w"), &MemoryStore::default()),
            Err(ProfileError::UnknownTarget(_))
        ));
    }
}
