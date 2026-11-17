//! Profile = agent (CLI) × credentials × config directory
//!
//! Multiple keys per CLI is a core premise. With separate profiles:
//! - keys are read from the keychain and passed as env vars only at launch
//! - key-related env vars from the parent process are not inherited (so they never mix)
//! - with `isolate`, the CLI gets a config directory of its own (the usual config is left untouched)

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use plyfold_acp::SpawnSpec;
use serde::{Deserialize, Serialize};

pub mod edit;
pub mod secrets;

pub use secrets::{KeychainStore, MemoryStore, SecretStore};

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("{}", plyfold_i18n::tr!("'{}' はプロファイルにもエージェントにもありません", "'{}' is neither a profile nor an agent", "'{}' 既不是配置，也不是代理", .0))]
    UnknownTarget(String),
    #[error("{}", plyfold_i18n::tr!("プロファイル '{}' のエージェント '{}' が定義されていません", "Agent '{1}' for profile '{0}' is not defined", "配置 '{}' 的代理 '{}' 未定义", .profile, .agent))]
    UnknownAgent { profile: String, agent: String },
    #[error("{}", plyfold_i18n::tr!("エージェント '{}' は config_dir_env がないので isolate できません", "Agent '{}' has no config_dir_env, so it cannot be isolated", "代理 '{}' 没有 config_dir_env，无法 isolate", .0))]
    CannotIsolate(String),
    #[error("{}", plyfold_i18n::tr!("{} のパスはプロファイルのディレクトリの中に限ります: {}", "{} paths must stay inside the profile directory: {}", "{} 的路径必须位于配置目录内：{}", .0, .1))]
    PathEscape(&'static str, String),
    #[error("{}", plyfold_i18n::tr!(
        "キーの取得元 '{}' は不明です（keychain / keychain:<名前>/<変数名> / env:VAR）",
        "Unknown key source '{}' (use keychain / keychain:<name>/<variable> / env:VAR)",
        "未知的密钥来源 '{}'（keychain / keychain:<名称>/<变量名> / env:VAR）",
        .0
    ))]
    BadKeySource(String),
    #[error("{}", plyfold_i18n::tr!("秘密の値を取得できません（{}）: {}", "Cannot get the secret ({}): {}", "无法获取机密值（{}）：{}", .account, .reason))]
    Secret { account: String, reason: String },
    #[error("{}", plyfold_i18n::tr!("設定ファイルを読めません: {}", "Cannot read the config file: {}", "无法读取设置文件：{}", .0))]
    Io(#[from] std::io::Error),
    #[error("{}", plyfold_i18n::tr!("設定ファイルの形式が不正です: {}", "The config file is malformed: {}", "设置文件格式无效：{}", .0))]
    Parse(#[from] toml::de::Error),
    #[error("{0}")]
    Form(String),
}

/// An agent launched over ACP
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentDef {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Env var for the config directory, overridden for separate profiles
    pub config_dir_env: Option<String>,
    /// Env vars not inherited from the parent except in the default profile
    #[serde(default)]
    pub key_envs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ProfileDef {
    pub agent: String,
    /// Display name
    pub label: Option<String>,
    #[serde(default)]
    pub isolate: bool,
    /// Env var name → source ("keychain" / "keychain:<name>/<var>" / "env:VAR")
    #[serde(default)]
    pub keys: BTreeMap<String, String>,
    /// `{profile_dir}` in a value is replaced with the profile directory
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Files to place in the isolated directory (relative path → contents)
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// Symlinks to create in the isolated directory (relative path → target; `~/` allowed).
    /// Login data is shared through links, since copies would conflict on token refresh
    #[serde(default)]
    pub links: BTreeMap<String, String>,
    /// Mode to switch to right after session/new
    pub default_mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Config {
    #[serde(default)]
    pub agents: BTreeMap<String, AgentDef>,
    #[serde(default)]
    pub profiles: BTreeMap<String, ProfileDef>,
}

/// Everything needed for a launch, resolved
#[derive(Debug, Clone)]
pub struct Resolved {
    pub profile: String,
    pub agent: String,
    pub label: String,
    pub spawn: SpawnSpec,
    pub default_mode: Option<String>,
    /// Summary of env vars for display (values masked)
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
        ("codex".into(), a("npx", &["-y", "@agentclientprotocol/codex-acp@2.6.0"], Some("CODEX_HOME"), &["OPENAI_API_KEY", "CODEX_API_KEY"])),
        ("opencode".into(), a("opencode", &["acp"], Some("XDG_DATA_HOME"), &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"])),
        ("gemini".into(), a("npx", &["-y", "@google/gemini-cli@0.68.0", "--experimental-acp"], None, &["GEMINI_API_KEY", "GOOGLE_API_KEY"])),
        ("mock".into(), a("plyfold-mock-agent", &[], None, &[])),
    ])
}

impl Config {
    /// Layers the file's contents over the built-in agent definitions
    pub fn from_toml(text: &str) -> Result<Self, ProfileError> {
        let file: Config = toml::from_str(text)?;
        let mut cfg = Config { agents: builtin_agents(), profiles: BTreeMap::new() };
        cfg.agents.extend(file.agents);
        cfg.profiles.extend(file.profiles);
        Ok(cfg)
    }

    /// Without a file, only the built-in definitions are used
    pub fn load(path: &Path) -> Result<Self, ProfileError> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::from_toml(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::from_toml(""),
            Err(e) => Err(e.into()),
        }
    }

    /// `target` is a profile or agent name (an agent name means the default profile, which overrides nothing)
    pub fn resolve(&self, target: &str, state_dir: &Path, cwd: &Path, secrets: &dyn SecretStore) -> Result<Resolved, ProfileError> {
        let profile = match self.profiles.get(target) {
            Some(p) => p.clone(),
            None if self.agents.contains_key(target) => ProfileDef { agent: target.into(), ..Default::default() },
            None => return Err(ProfileError::UnknownTarget(target.into())),
        };
        let agent = self.agents.get(&profile.agent).ok_or_else(|| ProfileError::UnknownAgent { profile: target.into(), agent: profile.agent.clone() })?;

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
                    reason: plyfold_i18n::tr!("環境変数がありません", "The environment variable is not set", "环境变量未设置"),
                })?
            } else {
                return Err(ProfileError::BadKeySource(source.clone()));
            };
            env_summary.push(format!("{var}=*** ({} chars)", value.chars().count()));
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
            spawn: SpawnSpec { command: agent.command.clone(), args: agent.args.clone(), cwd: cwd.to_path_buf(), env_set, env_remove, secrets: secret_values },
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

/// Default state directory on macOS
/// Where Plyfold keeps its state: ~/Library/Application Support/plyfold on macOS, %APPDATA%\plyfold on Windows
pub fn default_state_dir() -> PathBuf {
    dirs::data_dir().map(|d| d.join("plyfold")).unwrap_or_else(|| expand_home("~/.plyfold"))
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
label = "Claude (proxy)"
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
        assert!(r.spawn.env_remove.is_empty(), "the default profile removes nothing");
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
        assert_eq!(r.label, "Claude (proxy)");
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
        assert!(matches!(cfg.resolve("nope", &tmp("u"), Path::new("/w"), &MemoryStore::default()), Err(ProfileError::UnknownTarget(_))));
    }
}
