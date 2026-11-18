//! Profile = agent (CLI) × credentials × config directory
//!
//! Multiple keys per CLI is a core premise. With separate profiles:
//! - keys are read from the keychain and passed as env vars only at launch
//! - key-related env vars from the parent process are not inherited (so they never mix)
//! - with `isolate`, the CLI gets a config directory of its own (the usual config is left untouched)

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use plyfold_acp::SpawnSpec;
use plyfold_acp::schema::{McpServer, McpServerHttp, McpServerSse, McpServerStdio};
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
    /// Name to show (agents added from the ACP Registry; built-in ones are named by the UI)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The ACP Registry version this agent was added at (None: built in or written by hand)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_version: Option<String>,
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
    /// MCP servers for this profile. Passed on session/new, session/load and session/fork.
    /// Headers and environment values are not stored: both would be secrets, and the agent starts the server itself
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp: Vec<McpServerDef>,
}

/// One MCP server, as written in config.toml. `transport` is `stdio`, `http` or `sse`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum McpServerDef {
    Stdio {
        name: String,
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
    },
    Http {
        name: String,
        url: String,
    },
    Sse {
        name: String,
        url: String,
    },
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
    /// MCP servers from the profile, before capability and path checks
    pub mcp: Vec<McpServerDef>,
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
        name: None,
        registry_version: None,
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

        // A name from a hand-written config.toml is a folder name here: one plain component, as the UI allows
        let name = safe_rel("profile", target)?;
        if name.components().count() != 1 {
            return Err(ProfileError::PathEscape("profile", target.into()));
        }
        let profile_dir = state_dir.join("profiles").join(name);
        if profile.isolate {
            let var = agent.config_dir_env.as_ref().ok_or_else(|| ProfileError::CannotIsolate(profile.agent.clone()))?;
            std::fs::create_dir_all(&profile_dir)?;
            for (rel, content) in &profile.files {
                let rel_path = safe_rel("files", rel)?;
                // Never through a link (one an earlier run's "links" made, say): the file would land outside
                if through_link(&profile_dir, &rel_path) {
                    return Err(ProfileError::PathEscape("files", rel.clone()));
                }
                let p = profile_dir.join(rel_path);
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
                link_to(&dest, &link)?;
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
            mcp: profile.mcp.clone(),
            env_summary,
        })
    }
}

/// Servers to send, and one notice per server that was left out.
/// stdio is always allowed. HTTP and SSE are sent only when the agent advertised them.
/// A relative command with no path separator is looked up on PATH, because the protocol asks for an absolute path.
/// A server that cannot be sent is skipped; the session still starts.
pub fn prepare_mcp(servers: &[McpServerDef], http: bool, sse: bool) -> (Vec<McpServer>, Vec<String>) {
    let mut out = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for server in servers {
        let name = server.name().trim();
        if name.is_empty() {
            skipped.push(plyfold_i18n::tr!("名前のない MCP サーバーは渡しません", "An MCP server with no name was not passed", "未传递没有名称的 MCP 服务器"));
            continue;
        }
        if seen.contains(name) {
            skipped.push(plyfold_i18n::tr!(
                "MCP サーバー「{name}」は渡しません。同じ名前がすでにあります",
                "MCP server “{name}” was not passed. That name is already used",
                "未传递 MCP 服务器“{name}”。已有同名服务器"
            ));
            continue;
        }
        let built = match server {
            McpServerDef::Stdio { command, args, .. } => match resolve_stdio(name, command) {
                Ok(path) => Ok(McpServer::Stdio(McpServerStdio::new(name, path).args(args.clone()))),
                Err(reason) => Err(reason),
            },
            McpServerDef::Http { url, .. } => remote(name, url, http, "HTTP").map(|()| McpServer::Http(McpServerHttp::new(name, url.trim()))),
            McpServerDef::Sse { url, .. } => remote(name, url, sse, "SSE").map(|()| McpServer::Sse(McpServerSse::new(name, url.trim()))),
        };
        match built {
            Ok(built) => {
                seen.insert(name.to_string());
                out.push(built);
            }
            Err(reason) => skipped.push(reason),
        }
    }
    (out, skipped)
}

impl McpServerDef {
    fn name(&self) -> &str {
        match self {
            Self::Stdio { name, .. } | Self::Http { name, .. } | Self::Sse { name, .. } => name,
        }
    }
}

fn resolve_stdio(name: &str, command: &str) -> Result<PathBuf, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(plyfold_i18n::tr!(
            "MCP サーバー「{name}」は渡しません。コマンドが空です",
            "MCP server “{name}” was not passed. The command is empty",
            "未传递 MCP 服务器“{name}”。命令为空"
        ));
    }
    let path = Path::new(command);
    if path.is_absolute() {
        if path.is_file() {
            return Ok(path.to_path_buf());
        }
        return Err(plyfold_i18n::tr!(
            "MCP サーバー「{name}」は渡しません。コマンド {command} が見つかりません",
            "MCP server “{name}” was not passed. The command {command} was not found",
            "未传递 MCP 服务器“{name}”。找不到命令 {command}"
        ));
    }
    if command.contains('/') || command.contains('\\') {
        return Err(plyfold_i18n::tr!(
            "MCP サーバー「{name}」は渡しません。コマンドは絶対パスか、PATH にあるコマンド名にしてください",
            "MCP server “{name}” was not passed. Use an absolute path, or the name of a command on PATH",
            "未传递 MCP 服务器“{name}”。请使用绝对路径，或 PATH 中的命令名"
        ));
    }
    match which::which(command) {
        Ok(found) => Ok(found),
        Err(_) => Err(plyfold_i18n::tr!(
            "MCP サーバー「{name}」は渡しません。コマンド {command} が見つかりません",
            "MCP server “{name}” was not passed. The command {command} was not found",
            "未传递 MCP 服务器“{name}”。找不到命令 {command}"
        )),
    }
}

fn remote(name: &str, url: &str, advertised: bool, kind: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(plyfold_i18n::tr!("名前のない MCP サーバーは渡しません", "An MCP server with no name was not passed", "未传递没有名称的 MCP 服务器"));
    }
    if !advertised {
        return Err(plyfold_i18n::tr!(
            "MCP サーバー「{name}」は渡しません。このエージェントは {kind} に対応していません",
            "MCP server “{name}” was not passed. This agent does not support {kind}",
            "未传递 MCP 服务器“{name}”。此代理不支持 {kind}"
        ));
    }
    let url = url.trim();
    if url.starts_with("https://") || url.starts_with("http://") {
        return Ok(());
    }
    Err(plyfold_i18n::tr!(
        "MCP サーバー「{name}」は渡しません。URL は http:// か https:// で始めてください",
        "MCP server “{name}” was not passed. The URL must start with http:// or https://",
        "未传递 MCP 服务器“{name}”。URL 必须以 http:// 或 https:// 开头"
    ))
}

/// Whether the folder itself, or any part of `rel` under it, is a symbolic link
fn through_link(dir: &Path, rel: &Path) -> bool {
    let is_link = |p: &Path| p.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink());
    let mut p = dir.to_path_buf();
    if is_link(&p) {
        return true;
    }
    for c in rel.components() {
        p.push(c);
        if is_link(&p) {
            return true;
        }
    }
    false
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
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(p),
    }
}

/// Make `link` point at `dest` (a profile's shared file or folder). A symlink on macOS; on Windows a symlink when the
/// system allows it (Developer Mode or an administrator), else a copy of a file
fn link_to(dest: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dest, link)
    }
    #[cfg(windows)]
    {
        let made = if dest.is_dir() { std::os::windows::fs::symlink_dir(dest, link) } else { std::os::windows::fs::symlink_file(dest, link) };
        match made {
            Ok(()) => Ok(()),
            Err(_) if dest.is_file() => std::fs::copy(dest, link).map(|_| ()),
            Err(e) => Err(e),
        }
    }
}

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
    fn names_and_files_stay_inside_the_profile_folder() {
        let d = tmp("escape");
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let secrets = MemoryStore::default();
        // A name that is a path
        let toml = r#"
[agents.c]
command = "c"
config_dir_env = "C_HOME"
[profiles."../../x"]
agent = "c"
isolate = true
"#;
        let cfg = Config::from_toml(toml).unwrap();
        assert!(matches!(cfg.resolve("../../x", &d, &d, &secrets), Err(ProfileError::PathEscape("profile", _))));
        // One run's links leave a link where the next run's files write: that write must not go through it
        // (Windows needs a privilege to make links to folders)
        #[cfg(unix)]
        {
            let profile = |body: String| {
                Config::from_toml(&format!("[agents.c]\ncommand = \"c\"\nconfig_dir_env = \"C_HOME\"\n[profiles.p]\nagent = \"c\"\nisolate = true\n{body}"))
                    .unwrap()
            };
            let links = profile(format!("links = {{ \"sub\" = \"{}\" }}\n", outside.display().to_string().replace('\\', "/")));
            links.resolve("p", &d, &d, &secrets).unwrap();
            let files = profile("files = { \"sub/note\" = \"PLYFOLD-CANARY\" }\n".into());
            assert!(matches!(files.resolve("p", &d, &d, &secrets), Err(ProfileError::PathEscape("files", _))));
            assert!(!outside.join("note").exists());
        }
    }

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
        let dir = state.join("profiles").join("claude-proxy");
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
        let link = state.join("profiles").join("codex-own").join("auth.json");
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

    #[test]
    fn mcp_round_trips_and_is_filtered_at_launch() {
        let bin = tmp("mcp-bin").join("server");
        std::fs::write(&bin, "").unwrap();
        let toml = format!(
            r#"
[profiles.p]
agent = "claude"
[[profiles.p.mcp]]
transport = "stdio"
name = "files"
command = '{}'
args = ["--flag"]
[[profiles.p.mcp]]
transport = "stdio"
name = "tools"
command = "git"
[[profiles.p.mcp]]
transport = "stdio"
name = "missing"
command = "plyfold-no-such-mcp"
[[profiles.p.mcp]]
transport = "stdio"
name = "relative"
command = "./server"
[[profiles.p.mcp]]
transport = "http"
name = "docs"
url = "https://example.invalid/mcp"
[[profiles.p.mcp]]
transport = "sse"
name = "legacy"
url = "https://example.invalid/sse"
[[profiles.p.mcp]]
transport = "http"
name = "docs"
url = "https://example.invalid/again"
[[profiles.p.mcp]]
transport = "stdio"
name = " "
command = "git"
"#,
            bin.display()
        );
        let cfg = Config::from_toml(&toml).unwrap();
        assert_eq!(cfg.profiles["p"].mcp.len(), 8);
        let again = Config::from_toml(&toml::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(again.profiles["p"].mcp, cfg.profiles["p"].mcp);

        let (sent, skipped) = prepare_mcp(&cfg.profiles["p"].mcp, true, false);
        assert_eq!(sent.len(), 3, "{skipped:?}");
        match &sent[0] {
            McpServer::Stdio(s) => {
                assert_eq!(s.command, bin);
                assert_eq!(s.args, ["--flag"]);
                assert!(s.env.is_empty());
            }
            other => panic!("stdio first, got {other:?}"),
        }
        match &sent[1] {
            McpServer::Stdio(s) => assert!(s.command.is_absolute()),
            other => panic!("git resolved, got {other:?}"),
        }
        match &sent[2] {
            McpServer::Http(s) => {
                assert_eq!(s.url, "https://example.invalid/mcp");
                assert!(s.headers.is_empty());
            }
            other => panic!("http sent, got {other:?}"),
        }
        let notes = skipped.join("\n");
        for name in ["missing", "relative", "legacy", "docs"] {
            assert!(notes.contains(name), "{notes}");
        }
        assert!(notes.contains("名前のない") || notes.contains("no name") || notes.contains("没有名称"), "{notes}");

        let (no_http, skipped) = prepare_mcp(&cfg.profiles["p"].mcp, false, false);
        assert!(no_http.iter().all(|s| !matches!(s, McpServer::Http(_))));
        assert!(skipped.iter().any(|s| s.contains("docs") && s.contains("HTTP")));
    }
}
