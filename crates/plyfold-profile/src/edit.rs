//! A simplified profile form for editing from the UI, and rewriting config.toml
//!
//! The UI deals with auth kind, base URL, dedicated directory and MCP servers.
//! Per-agent env var names and the contents of Codex's config.toml are decided here.
//! Hand-written fields (default_mode, links, ...) survive a save. MCP servers are edited in the form,
//! so a save writes the list the form is showing.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use toml_edit::DocumentMut;

use crate::{Config, McpServerDef, ProfileDef, ProfileError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    /// Reuse the CLI's existing login as is
    Login,
    /// Connect to the official API with a key
    Api,
    /// Custom provider (base URL + key)
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileForm {
    pub name: String,
    pub agent: String,
    pub label: Option<String>,
    pub auth: AuthKind,
    pub base_url: Option<String>,
    pub isolate: bool,
    /// MCP servers. `transport` is `stdio`, `http` or `sse`. `args` is only used for stdio
    #[serde(default)]
    pub mcp: Vec<McpForm>,
    /// Profile to continue with when this one's key hits a rate or usage limit (same agent)
    #[serde(default)]
    pub fallback: Option<String>,
    /// Model name to send instead of the agent's own (a custom provider often has names of its own)
    #[serde(default)]
    pub model: Option<String>,
}

/// One MCP server in the form. Unused fields stay empty (a URL for stdio, a command for HTTP)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpForm {
    pub transport: String,
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
}

/// How each agent receives the key and base URL
struct AuthSpec {
    api_key: &'static str,
    custom_key: &'static str,
    /// If None, the base URL is written to the agent's own config file (Codex's config.toml, OpenCode's
    /// opencode.json)
    custom_base: Option<&'static str>,
    /// Whether a custom provider needs a config file of its own (which means a directory of its own)
    writes_config: bool,
}

/// Env var that passes the key for a Codex custom provider (env_key in config.toml)
const CODEX_PROVIDER_KEY: &str = "PLYFOLD_PROVIDER_KEY";

/// OpenCode reads the key from the provider block of opencode.json, so no variable carries it
const OPENCODE_PROVIDER_KEY: &str = "OPENCODE_PROVIDER_KEY";

/// Where opencode.json goes inside a profile directory: XDG_CONFIG_HOME is the profile directory, and OpenCode reads
/// its configuration from $XDG_CONFIG_HOME/opencode/opencode.json
const OPENCODE_CONFIG_FILE: &str = "opencode/opencode.json";

fn spec(agent: &str) -> Option<AuthSpec> {
    match agent {
        "claude" => {
            Some(AuthSpec { api_key: "ANTHROPIC_API_KEY", custom_key: "ANTHROPIC_AUTH_TOKEN", custom_base: Some("ANTHROPIC_BASE_URL"), writes_config: false })
        }
        "codex" => Some(AuthSpec { api_key: "OPENAI_API_KEY", custom_key: CODEX_PROVIDER_KEY, custom_base: None, writes_config: true }),
        "gemini" => {
            Some(AuthSpec { api_key: "GEMINI_API_KEY", custom_key: "GEMINI_API_KEY", custom_base: Some("GOOGLE_GEMINI_BASE_URL"), writes_config: false })
        }
        "opencode" => Some(AuthSpec { api_key: "OPENAI_API_KEY", custom_key: OPENCODE_PROVIDER_KEY, custom_base: None, writes_config: true }),
        // Antigravity (from the ACP Registry): a Gemini API key, and a gateway through the same base URL variable
        "antigravity-acp" => {
            Some(AuthSpec { api_key: "GEMINI_API_KEY", custom_key: "GEMINI_API_KEY", custom_base: Some("GOOGLE_GEMINI_BASE_URL"), writes_config: false })
        }
        _ => None,
    }
}

/// Auth kinds available for this agent
pub fn supported_auth(agent: &str) -> Vec<AuthKind> {
    match spec(agent) {
        Some(_) => vec![AuthKind::Login, AuthKind::Api, AuthKind::Custom],
        None => vec![AuthKind::Login],
    }
}

/// Env var that carries the key (None for login)
pub fn key_var(agent: &str, auth: AuthKind) -> Option<&'static str> {
    let s = spec(agent)?;
    match auth {
        AuthKind::Login => None,
        AuthKind::Api => Some(s.api_key),
        AuthKind::Custom => Some(s.custom_key),
    }
}

/// Variables that set Claude Code's model: the default, what each alias in its model menu stands for, and helper
/// agents. All get the same name, so every choice in the menu reaches a provider that knows only its own names
const CLAUDE_MODEL_VARS: [&str; 5] =
    ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
const GEMINI_MODEL_VAR: &str = "GEMINI_MODEL";

/// Codex's config.toml: the custom provider (when there is a base URL) and the model (when one is set)
fn codex_toml(base_url: Option<&str>, model: Option<&str>) -> String {
    let mut doc: DocumentMut = match base_url {
        Some(url) => codex_provider_toml(url).parse().unwrap_or_default(),
        None => DocumentMut::new(),
    };
    if let Some(m) = model {
        doc["model"] = toml_edit::value(m);
    }
    doc.to_string()
}

fn codex_model(files: &BTreeMap<String, String>) -> Option<String> {
    let doc: DocumentMut = files.get("config.toml")?.parse().ok()?;
    doc.get("model")?.as_str().map(str::to_string)
}

fn codex_provider_toml(base_url: &str) -> String {
    let mut doc = DocumentMut::new();
    doc["model_provider"] = toml_edit::value("plyfold");
    let mut p = toml_edit::Table::new();
    p["name"] = toml_edit::value("plyfold");
    p["base_url"] = toml_edit::value(base_url);
    p["env_key"] = toml_edit::value(CODEX_PROVIDER_KEY);
    p["wire_api"] = toml_edit::value("responses");
    let mut providers = toml_edit::Table::new();
    providers.set_implicit(true);
    providers["plyfold"] = toml_edit::Item::Table(p);
    doc["model_providers"] = toml_edit::Item::Table(providers);
    doc.to_string()
}

fn codex_base_url(files: &BTreeMap<String, String>) -> Option<String> {
    let doc: DocumentMut = files.get("config.toml")?.parse().ok()?;
    let name = doc.get("model_provider")?.as_str()?;
    doc.get("model_providers")?.get(name)?.get("base_url")?.as_str().map(str::to_string)
}

/// OpenCode's opencode.json: the custom provider (when there is a base URL) and the model (when one is set).
/// The key is not written here: the file names the environment variable it arrives in, as Codex's config.toml does
fn opencode_json(base_url: Option<&str>, model: Option<&str>) -> String {
    let mut doc = serde_json::Map::new();
    if let Some(url) = base_url {
        let mut provider = serde_json::Map::new();
        provider.insert("npm".into(), serde_json::Value::String("@ai-sdk/openai-compatible".into()));
        provider.insert("name".into(), serde_json::Value::String("Plyfold".into()));
        let mut options = serde_json::Map::new();
        options.insert("baseURL".into(), serde_json::Value::String(url.into()));
        // OpenCode reads `{env:VAR}` in the file, so the key stays out of it (as with Codex's env_key)
        options.insert("apiKey".into(), serde_json::Value::String(format!("{{env:{OPENCODE_PROVIDER_KEY}}}")));
        provider.insert("options".into(), serde_json::Value::Object(options));
        let mut models = serde_json::Map::new();
        if let Some(m) = model {
            let mut entry = serde_json::Map::new();
            entry.insert("name".into(), serde_json::Value::String(m.into()));
            models.insert(m.into(), serde_json::Value::Object(entry));
        }
        provider.insert("models".into(), serde_json::Value::Object(models));
        let mut providers = serde_json::Map::new();
        providers.insert("plyfold".into(), serde_json::Value::Object(provider));
        doc.insert("provider".into(), serde_json::Value::Object(providers));
        if let Some(m) = model {
            // Models are chosen as "<provider>/<model>"
            doc.insert("model".into(), serde_json::Value::String(format!("plyfold/{m}")));
        }
    } else if let Some(m) = model {
        doc.insert("model".into(), serde_json::Value::String(m.into()));
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(doc)).unwrap_or_default()
}

/// The base URL and model written to opencode.json, when it holds a Plyfold provider
fn opencode_parts(files: &BTreeMap<String, String>) -> (Option<String>, Option<String>) {
    let Some(doc) = files.get(OPENCODE_CONFIG_FILE).and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok()) else {
        return (None, None);
    };
    let base = doc["provider"]["plyfold"]["options"]["baseURL"].as_str().map(str::to_string);
    let model = doc["provider"]["plyfold"]["models"]
        .as_object()
        .and_then(|m| m.keys().next().cloned())
        .or_else(|| doc["model"].as_str().map(|m| m.strip_prefix("plyfold/").unwrap_or(m).to_string()));
    (base, model)
}

/// Converts a stored definition into the UI form
pub fn describe(name: &str, def: &ProfileDef) -> ProfileForm {
    let base = |var: Option<&str>| match var {
        Some(v) => def.env.get(v).cloned(),
        None if def.agent == "opencode" => opencode_parts(&def.files).0,
        None => codex_base_url(&def.files),
    };
    let (auth, base_url) = match spec(&def.agent) {
        Some(s) if def.keys.contains_key(s.custom_key) && base(s.custom_base).is_some() => (AuthKind::Custom, base(s.custom_base)),
        Some(s) if def.keys.contains_key(s.api_key) => (AuthKind::Api, None),
        _ => (AuthKind::Login, None),
    };
    ProfileForm {
        name: name.into(),
        agent: def.agent.clone(),
        label: def.label.clone(),
        auth,
        base_url,
        isolate: def.isolate,
        mcp: def.mcp.iter().map(McpForm::from).collect(),
        fallback: def.fallback.clone(),
        model: match def.agent.as_str() {
            "claude" => def.env.get(CLAUDE_MODEL_VARS[0]).cloned(),
            "gemini" => def.env.get(GEMINI_MODEL_VAR).cloned(),
            "codex" => codex_model(&def.files),
            "opencode" => opencode_parts(&def.files).1,
            _ => None,
        },
    }
}

impl From<&McpServerDef> for McpForm {
    fn from(server: &McpServerDef) -> Self {
        match server {
            McpServerDef::Stdio { name, command, args } => {
                Self { transport: "stdio".into(), name: name.clone(), command: command.clone(), args: args.clone(), url: String::new() }
            }
            McpServerDef::Http { name, url } => {
                Self { transport: "http".into(), name: name.clone(), command: String::new(), args: Vec::new(), url: url.clone() }
            }
            McpServerDef::Sse { name, url } => Self { transport: "sse".into(), name: name.clone(), command: String::new(), args: Vec::new(), url: url.clone() },
        }
    }
}

/// Builds a definition from the UI form, keeping fields of the existing definition that the UI does not handle
pub fn to_def(form: &ProfileForm, existing: Option<&ProfileDef>) -> Result<ProfileDef, ProfileError> {
    let mut def = existing.cloned().unwrap_or_default();
    let changed_agent = def.agent != form.agent;
    def.agent = form.agent.clone();
    def.label = form.label.clone().filter(|l| !l.trim().is_empty());
    def.isolate = form.isolate;
    def.fallback = form.fallback.clone().filter(|f| !f.trim().is_empty() && *f != form.name);

    let s = spec(&form.agent);
    if form.auth != AuthKind::Login && s.is_none() {
        return Err(ProfileError::Form(plyfold_i18n::tr!(
            "{} はキーでの接続に対応していません",
            "{} does not support connecting with a key",
            "{} 不支持通过 API 密钥连接",
            form.agent
        )));
    }
    // Replace only the variables the UI manages (leave the others alone)
    let all_key_vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", CODEX_PROVIDER_KEY, OPENCODE_PROVIDER_KEY];
    let all_base_vars = ["ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL"];
    let old_keys = std::mem::take(&mut def.keys);
    let keep_source = |var: &str| old_keys.get(var).filter(|_| !changed_agent).cloned().unwrap_or_else(|| "keychain".into());
    for (k, v) in &old_keys {
        if !all_key_vars.contains(&k.as_str()) {
            def.keys.insert(k.clone(), v.clone());
        }
    }
    for v in all_base_vars.iter().chain(&CLAUDE_MODEL_VARS).chain(&[GEMINI_MODEL_VAR]) {
        def.env.remove(*v);
    }
    let model = form.model.as_deref().map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = model
        && (m.len() > 200 || m.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\'))
    {
        return Err(ProfileError::Form(plyfold_i18n::tr!(
            "モデル名に空白や引用符は使えません",
            "A model name has no spaces or quotes",
            "模型名称不能包含空格或引号"
        )));
    }
    if def.agent == "codex" || changed_agent {
        def.files.remove("config.toml");
    }
    if def.agent == "opencode" || changed_agent {
        def.files.remove(OPENCODE_CONFIG_FILE);
    }

    if let (Some(s), Some(var)) = (s, key_var(&form.agent, form.auth)) {
        def.keys.insert(var.into(), keep_source(var));
        if form.auth == AuthKind::Custom {
            let url = form
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .ok_or_else(|| ProfileError::Form(plyfold_i18n::tr!("ベース URL を入力してください", "Enter a base URL", "请输入 Base URL")))?;
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(ProfileError::Form(plyfold_i18n::tr!(
                    "ベース URL は http:// か https:// で始めてください",
                    "The base URL must start with http:// or https://",
                    "Base URL 必须以 http:// 或 https:// 开头"
                )));
            }
            match s.custom_base {
                Some(env) => {
                    def.env.insert(env.into(), url.into());
                }
                None if s.writes_config => {
                    // Codex and OpenCode keep the provider in a config file, so they need a dedicated directory
                    def.isolate = true;
                    if def.agent == "opencode" {
                        def.files.insert(OPENCODE_CONFIG_FILE.into(), opencode_json(Some(url), model));
                    } else {
                        def.files.insert("config.toml".into(), codex_toml(Some(url), model));
                    }
                }
                None => {} // an agent with no way to take a base URL (none today)
            }
        }
    }
    if let Some(m) = model {
        match def.agent.as_str() {
            "claude" => {
                for v in CLAUDE_MODEL_VARS {
                    def.env.insert(v.into(), m.into());
                }
            }
            "gemini" => {
                def.env.insert(GEMINI_MODEL_VAR.into(), m.into());
            }
            // Already written with the provider; otherwise a config.toml of its own (so a directory of its own)
            "codex" if !def.files.contains_key("config.toml") => {
                def.isolate = true;
                def.files.insert("config.toml".into(), codex_toml(None, Some(m)));
            }
            // The model goes in the provider block, so a provider needs one; without it, only the model is written
            "opencode" => {
                def.isolate = true;
                let base = opencode_parts(&def.files).0;
                def.files.insert(OPENCODE_CONFIG_FILE.into(), opencode_json(base.as_deref(), Some(m)));
            }
            _ => {}
        }
    }
    def.mcp = mcp_servers(&form.mcp)?;
    Ok(def)
}

/// Servers from the UI form, checked; names must not repeat
pub fn mcp_servers(forms: &[McpForm]) -> Result<Vec<McpServerDef>, ProfileError> {
    let servers = forms.iter().map(mcp_from_form).collect::<Result<Vec<_>, _>>()?;
    let mut names = std::collections::HashSet::new();
    for server in &servers {
        let name = server.name();
        if !names.insert(name.to_string()) {
            return Err(ProfileError::Form(plyfold_i18n::tr!(
                "MCP サーバーの名前「{name}」が重複しています",
                "MCP server name “{name}” is used more than once",
                "MCP 服务器的名称“{name}”重复"
            )));
        }
    }
    Ok(servers)
}

/// Writes the MCP servers shared by every profile ([[mcp]] at the top of config.toml); an empty list removes them
pub fn set_shared_mcp(path: &Path, servers: &[McpServerDef]) -> Result<(), ProfileError> {
    let mut doc = read_doc(path)?;
    doc.remove("mcp");
    if !servers.is_empty() {
        #[derive(Serialize)]
        struct Shared<'a> {
            mcp: &'a [McpServerDef],
        }
        let value = toml_edit::ser::to_document(&Shared { mcp: servers }).map_err(|e| ProfileError::Form(e.to_string()))?;
        if let Some(item) = value.get("mcp") {
            // [[mcp]] headers: valid wherever they land among [agents] and [profiles]
            doc.insert("mcp", item.clone());
        }
    }
    write_doc(path, &doc)
}

fn mcp_from_form(form: &McpForm) -> Result<McpServerDef, ProfileError> {
    let name = form.name.trim();
    if name.is_empty() || name.len() > 40 || name.chars().any(char::is_whitespace) {
        return Err(ProfileError::Form(plyfold_i18n::tr!(
            "MCP サーバーの名前は空白を入れず、40 文字までにしてください",
            "An MCP server name has no spaces and is at most 40 characters",
            "MCP 服务器的名称不能含空格，且不超过 40 个字符"
        )));
    }
    let names_ok = name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !names_ok {
        return Err(ProfileError::Form(plyfold_i18n::tr!(
            "MCP サーバーの名前は英数字と . - _ だけにしてください",
            "Use only letters, digits, . - and _ in an MCP server name",
            "MCP 服务器的名称只能包含字母、数字、.、- 和 _"
        )));
    }
    match form.transport.as_str() {
        "stdio" => {
            let command = form.command.trim();
            if command.is_empty() {
                return Err(ProfileError::Form(plyfold_i18n::tr!(
                    "MCP サーバー「{name}」のコマンドを入力してください",
                    "Enter a command for MCP server “{name}”",
                    "请输入 MCP 服务器“{name}”的命令"
                )));
            }
            let args = form.args.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).map(str::to_string).collect();
            Ok(McpServerDef::Stdio { name: name.into(), command: command.into(), args })
        }
        "http" | "sse" => {
            let url = form.url.trim();
            if !crate::mcp_url_ok(url) {
                return Err(ProfileError::Form(plyfold_i18n::tr!(
                    "MCP サーバー「{name}」の URL は https:// で始めてください（http:// はこの機械のサーバーだけ）",
                    "The URL for MCP server “{name}” must start with https:// (http:// only for a server on this machine)",
                    "MCP 服务器“{name}”的 URL 必须以 https:// 开头（http:// 仅限本机的服务器）"
                )));
            }
            if form.transport == "http" {
                Ok(McpServerDef::Http { name: name.into(), url: url.into() })
            } else {
                Ok(McpServerDef::Sse { name: name.into(), url: url.into() })
            }
        }
        _ => Err(ProfileError::Form(plyfold_i18n::tr!(
            "MCP サーバー「{name}」の種類が不明です",
            "MCP server “{name}” has an unknown kind",
            "MCP 服务器“{name}”的类型未知"
        ))),
    }
}

/// Keychain account name ("keychain" → "<profile>/<var>", "keychain:<name>" → "<name>")
pub fn key_account(name: &str, def: &ProfileDef) -> Option<(String, String)> {
    let form = describe(name, def);
    let var = key_var(&def.agent, form.auth)?;
    let source = def.keys.get(var)?;
    let account = if source == "keychain" { format!("{name}/{var}") } else { source.strip_prefix("keychain:")?.to_string() };
    Some((var.into(), account))
}

/// Characters allowed in a profile name (it becomes a directory name and a keychain account name)
pub fn validate_name(name: &str, config: &Config) -> Result<(), ProfileError> {
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ProfileError::Form(plyfold_i18n::tr!(
            "名前は英数字と - _ だけで、40 文字までにしてください",
            "Use only letters, digits, - and _ in the name, up to 40 characters",
            "名称只能包含字母、数字、- 和 _，且不超过 40 个字符"
        )));
    }
    if config.agents.contains_key(name) {
        return Err(ProfileError::Form(plyfold_i18n::tr!(
            "'{name}' はエージェントの名前なので使えません",
            "'{name}' is an agent name and cannot be used",
            "'{name}' 是代理的名称，不能使用"
        )));
    }
    Ok(())
}

fn read_doc(path: &Path) -> Result<DocumentMut, ProfileError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    text.parse::<DocumentMut>()
        .map_err(|e| ProfileError::Form(plyfold_i18n::tr!("設定ファイルの形式が不正です: {e}", "The config file is malformed: {e}", "设置文件格式无效：{e}")))
}

fn write_doc(path: &Path, doc: &DocumentMut) -> Result<(), ProfileError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Write to a separate file and then replace, so a crash midway cannot corrupt it
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string())?;
    // Profiles name providers and keys' keychain entries: this user only
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// Rewrites [profiles.<name>] in config.toml (other sections and comments are kept)
pub fn upsert_profile(path: &Path, name: &str, def: &ProfileDef) -> Result<(), ProfileError> {
    let mut doc = read_doc(path)?;
    let value = toml_edit::ser::to_document(def).map_err(|e| ProfileError::Form(e.to_string()))?;
    if !doc.contains_key("profiles") {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        doc["profiles"] = toml_edit::Item::Table(t);
    }
    let profiles = doc["profiles"]
        .as_table_mut()
        .ok_or_else(|| ProfileError::Form(plyfold_i18n::tr!("profiles が表ではありません", "profiles is not a table", "profiles 不是表")))?;
    let mut table = value.as_table().clone();
    for (_, item) in table.iter_mut() {
        if let Some(t) = item.as_table_mut() {
            t.set_implicit(false);
        }
    }
    profiles[name] = toml_edit::Item::Table(table);
    write_doc(path, &doc)
}

/// Writes [agents.<id>] (an agent added from the ACP Registry)
pub fn upsert_agent(path: &Path, id: &str, def: &crate::AgentDef) -> Result<(), ProfileError> {
    let mut doc = read_doc(path)?;
    let value = toml_edit::ser::to_document(def).map_err(|e| ProfileError::Form(e.to_string()))?;
    if !doc.contains_key("agents") {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        doc["agents"] = toml_edit::Item::Table(t);
    }
    let agents = doc["agents"]
        .as_table_mut()
        .ok_or_else(|| ProfileError::Form(plyfold_i18n::tr!("agents が表ではありません", "agents is not a table", "agents 不是表")))?;
    let mut table = value.as_table().clone();
    for (_, item) in table.iter_mut() {
        if let Some(t) = item.as_table_mut() {
            t.set_implicit(false);
        }
    }
    agents[id] = toml_edit::Item::Table(table);
    write_doc(path, &doc)
}

pub fn remove_agent(path: &Path, id: &str) -> Result<(), ProfileError> {
    let mut doc = read_doc(path)?;
    if let Some(a) = doc.get_mut("agents").and_then(|a| a.as_table_mut()) {
        a.remove(id);
    }
    write_doc(path, &doc)
}

pub fn remove_profile(path: &Path, name: &str) -> Result<(), ProfileError> {
    let mut doc = read_doc(path)?;
    if let Some(p) = doc.get_mut("profiles").and_then(|p| p.as_table_mut()) {
        p.remove(name);
    }
    write_doc(path, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(agent: &str, auth: AuthKind, url: Option<&str>) -> ProfileForm {
        ProfileForm {
            name: "p".into(),
            agent: agent.into(),
            label: None,
            auth,
            base_url: url.map(str::to_string),
            isolate: true,
            mcp: Vec::new(),
            fallback: None,
            model: None,
        }
    }

    #[test]
    fn writes_and_removes_an_agent() {
        let dir = std::env::temp_dir().join(format!("plyfold-agent-edit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "# mine\n[profiles.work]\nagent = \"claude\"\n").unwrap();
        let def = crate::AgentDef {
            command: "npx".into(),
            args: vec!["-y".into(), "@qwen-code/qwen-code@0.28.0".into(), "--acp".into()],
            env: Default::default(),
            config_dir_env: None,
            key_envs: vec![],
            name: Some("Qwen Code".into()),
            registry_version: Some("0.28.0".into()),
        };
        upsert_agent(&path, "qwen-code", &def).unwrap();
        let cfg = crate::Config::load(&path).unwrap();
        assert_eq!(cfg.agents["qwen-code"], def);
        assert!(cfg.profiles.contains_key("work"));
        assert!(std::fs::read_to_string(&path).unwrap().starts_with("# mine"));
        remove_agent(&path, "qwen-code").unwrap();
        assert!(!crate::Config::load(&path).unwrap().agents.contains_key("qwen-code"));
    }

    #[test]
    fn round_trips_each_auth() {
        for agent in ["claude", "codex", "gemini", "opencode", "antigravity-acp"] {
            for (auth, url) in [(AuthKind::Login, None), (AuthKind::Api, None), (AuthKind::Custom, Some("https://gw.example.com/v1"))] {
                let f = form(agent, auth, url);
                let def = to_def(&f, None).unwrap();
                assert_eq!(describe("p", &def), f, "{agent} {auth:?}");
            }
        }
    }

    /// OpenCode keeps a custom provider in opencode.json under a directory of its own (XDG_CONFIG_HOME), and the key
    /// reaches it through the environment, never through the file
    #[test]
    fn opencode_custom_provider_goes_into_its_own_opencode_json() {
        let mut f = form("opencode", AuthKind::Custom, Some("https://gw.example.com/v1"));
        f.model = Some("qwen3-coder".into());
        let def = to_def(&f, None).unwrap();
        assert!(def.isolate, "a custom provider needs a directory of its own");
        assert_eq!(def.keys.get(OPENCODE_PROVIDER_KEY).map(String::as_str), Some("keychain"));
        assert!(!def.keys.contains_key("OPENAI_API_KEY"));
        let text = def.files.get(OPENCODE_CONFIG_FILE).expect("opencode.json is written");
        // The key itself is not in the file
        assert!(!text.contains("sk-"), "{text}");
        assert!(text.contains("{env:OPENCODE_PROVIDER_KEY}"), "{text}");
        let doc: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(doc["provider"]["plyfold"]["options"]["baseURL"], "https://gw.example.com/v1");
        assert_eq!(doc["provider"]["plyfold"]["models"]["qwen3-coder"]["name"], "qwen3-coder");
        // A model is chosen as "<provider>/<model>"
        assert_eq!(doc["model"], "plyfold/qwen3-coder");
        // The form comes back as it was saved
        assert_eq!(describe("p", &def), f);
    }

    /// The official API keeps the usual login directory (no opencode.json), as the other agents do
    #[test]
    fn opencode_api_key_needs_no_config_file() {
        let mut f = form("opencode", AuthKind::Api, None);
        f.isolate = false;
        let def = to_def(&f, None).unwrap();
        assert_eq!(def.keys.get("OPENAI_API_KEY").map(String::as_str), Some("keychain"));
        assert!(def.files.is_empty());
        // A custom provider is the one that forces a directory of its own
        f.auth = AuthKind::Custom;
        f.base_url = Some("https://gw.example.com/v1".into());
        assert!(to_def(&f, None).unwrap().isolate);
    }

    /// A model on its own still gets a file, since OpenCode names models "<provider>/<model>"
    #[test]
    fn opencode_model_alone_is_written() {
        let mut f = form("opencode", AuthKind::Login, None);
        f.model = Some("gpt-6-luna".into());
        let def = to_def(&f, None).unwrap();
        let text = def.files.get(OPENCODE_CONFIG_FILE).expect("opencode.json is written");
        let doc: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(doc["model"], "gpt-6-luna");
        assert!(doc.get("provider").is_none(), "no provider block without a base URL: {text}");
        assert_eq!(describe("p", &def), f);
    }

    #[test]
    fn keeps_fields_the_form_does_not_know() {
        let mut old = to_def(&form("claude", AuthKind::Api, None), None).unwrap();
        old.default_mode = Some("plan".into());
        old.keys.insert("ANTHROPIC_API_KEY".into(), "keychain:shared/KEY".into());
        old.env.insert("FOO".into(), "1".into());
        let new = to_def(&form("claude", AuthKind::Custom, Some("https://gw.example.com")), Some(&old)).unwrap();
        assert_eq!(new.default_mode.as_deref(), Some("plan"));
        assert_eq!(new.env.get("FOO").map(String::as_str), Some("1"));
        assert!(!new.keys.contains_key("ANTHROPIC_API_KEY"));
        assert_eq!(new.keys.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str), Some("keychain"));
        // For the same variable, keep the shared key reference
        let back = to_def(&form("claude", AuthKind::Api, None), Some(&old)).unwrap();
        assert_eq!(back.keys.get("ANTHROPIC_API_KEY").map(String::as_str), Some("keychain:shared/KEY"));
        assert_eq!(key_account("p", &back), Some(("ANTHROPIC_API_KEY".into(), "shared/KEY".into())));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(to_def(&form("claude", AuthKind::Custom, None), None).is_err());
        assert!(to_def(&form("claude", AuthKind::Custom, Some("gw.example.com")), None).is_err());
        let cfg = Config::from_toml("").unwrap();
        assert!(validate_name("work", &cfg).is_ok());
        assert!(validate_name("claude", &cfg).is_err());
        assert!(validate_name("../x", &cfg).is_err());
    }

    #[test]
    fn mcp_survives_a_save_and_rejects_a_bad_row() {
        let mut f = form("claude", AuthKind::Login, None);
        f.mcp = vec![
            McpForm { transport: "stdio".into(), name: "files".into(), command: "npx".into(), args: vec!["-y".into(), "srv".into()], url: String::new() },
            McpForm { transport: "http".into(), name: "docs".into(), command: String::new(), args: Vec::new(), url: "https://example.invalid/mcp".into() },
        ];
        let def = to_def(&f, None).unwrap();
        assert_eq!(describe("p", &def), f);
        let dir = std::env::temp_dir().join(format!("plyfold-mcp-edit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        upsert_profile(&path, "p", &def).unwrap();
        let loaded = crate::Config::load(&path).unwrap();
        assert_eq!(loaded.profiles["p"].mcp, def.mcp);

        f.mcp.push(McpForm {
            transport: "sse".into(),
            name: "docs".into(),
            command: String::new(),
            args: Vec::new(),
            url: "https://example.invalid/sse".into(),
        });
        assert!(to_def(&f, None).is_err());
        f.mcp.pop();
        f.mcp[1].url = "example.invalid".into();
        assert!(to_def(&f, None).is_err());
    }

    #[test]
    fn edits_file_and_keeps_comments() {
        let dir = std::env::temp_dir().join(format!("plyfold-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "# hand-written note\n[profiles.keep]\nagent = \"claude\"\n").unwrap();
        let def = to_def(&form("codex", AuthKind::Custom, Some("https://gw.example.com/v1")), None).unwrap();
        upsert_profile(&path, "proxy", &def).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# hand-written note"));
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.profiles["proxy"], def);
        assert!(cfg.profiles.contains_key("keep"));
        remove_profile(&path, "proxy").unwrap();
        let cfg = Config::load(&path).unwrap();
        assert!(!cfg.profiles.contains_key("proxy"));
        assert!(cfg.profiles.contains_key("keep"));
    }

    #[test]
    fn a_model_name_reaches_every_choice_and_comes_back() {
        let mut f = form("claude", AuthKind::Custom, Some("https://llm.example.com/api"));
        f.model = Some("router-x".into());
        let def = to_def(&f, None).unwrap();
        for v in CLAUDE_MODEL_VARS {
            assert_eq!(def.env.get(v).map(String::as_str), Some("router-x"), "{v}");
        }
        assert_eq!(describe("p", &def).model.as_deref(), Some("router-x"));
        // Cleared: the variables go
        f.model = None;
        let def = to_def(&f, Some(&def)).unwrap();
        assert!(CLAUDE_MODEL_VARS.iter().all(|v| !def.env.contains_key(*v)));

        let mut c = form("codex", AuthKind::Custom, Some("https://llm.example.com/v1"));
        c.model = Some("router-y".into());
        let def = to_def(&c, None).unwrap();
        let toml = &def.files["config.toml"];
        assert!(toml.contains("model = \"router-y\"") && toml.contains("base_url"));
        assert_eq!(describe("p", &def).model.as_deref(), Some("router-y"));
        assert_eq!(describe("p", &def).base_url.as_deref(), Some("https://llm.example.com/v1"));

        c.model = Some("bad name".into());
        assert!(to_def(&c, None).is_err());
    }

    #[test]
    fn shared_mcp_servers_round_trip_beside_profiles() {
        let dir = std::env::temp_dir().join(format!("plyfold-shared-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("config.toml");
        upsert_profile(&path, "p", &to_def(&form("claude", AuthKind::Login, None), None).unwrap()).unwrap();
        let servers = mcp_servers(&[
            McpForm { transport: "http".into(), name: "docs".into(), command: String::new(), args: Vec::new(), url: "https://mcp.example.com/docs".into() },
            McpForm { transport: "stdio".into(), name: "fs".into(), command: "mcp-fs".into(), args: vec!["--ro".into()], url: String::new() },
        ])
        .unwrap();
        set_shared_mcp(&path, &servers).unwrap();
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.mcp, servers);
        assert!(cfg.profiles.contains_key("p"), "profiles are kept");
        set_shared_mcp(&path, &[]).unwrap();
        assert!(Config::load(&path).unwrap().mcp.is_empty());
        let dup = McpForm { transport: "http".into(), name: "docs".into(), command: String::new(), args: Vec::new(), url: "https://a.example.com".into() };
        assert!(mcp_servers(&[dup.clone(), dup]).is_err());
    }
}
