use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;

use crate::keys;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub agents: BTreeMap<String, AgentDef>,
    #[serde(default)]
    pub profiles: BTreeMap<String, ProfileDef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentDef {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub config_dir_env: Option<String>,
    #[serde(default)]
    pub key_envs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileDef {
    pub agent: String,
    #[serde(default)]
    pub isolate: bool,
    #[serde(default)]
    pub keys: BTreeMap<String, String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Files to write into the isolated directory (relative path = contents), e.g. Codex's config.toml
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// Symlinks to create in the isolated directory (relative path = target; ~ allowed).
    /// Login state is shared via links, since copies would conflict on token refresh
    #[serde(default)]
    pub links: BTreeMap<String, String>,
}

/// Everything resolved for a single launch
#[derive(Debug, Clone)]
pub struct Launch {
    pub agent: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    /// Values that must never appear in logs
    pub secrets: Vec<String>,
    /// For display (values masked)
    pub env_summary: Vec<String>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("cannot read config file: {}", path.display()))?;
        let mut cfg: Config = toml::from_str(&text).with_context(|| format!("invalid config file: {}", path.display()))?;

        // Overlay a sibling *.local.toml (kept out of git) if there is one
        let local = path.with_extension("local.toml");
        if local.exists() {
            let text = std::fs::read_to_string(&local)?;
            #[derive(Deserialize, Default)]
            struct Overlay {
                #[serde(default)]
                agents: BTreeMap<String, AgentDef>,
                #[serde(default)]
                profiles: BTreeMap<String, ProfileDef>,
            }
            let o: Overlay = toml::from_str(&text).with_context(|| format!("invalid config file: {}", local.display()))?;
            cfg.agents.extend(o.agents);
            cfg.profiles.extend(o.profiles);
        }
        Ok(cfg)
    }

    /// `target` is a profile name or an agent name
    pub fn resolve(&self, target: &str, state_dir: &Path) -> Result<Launch> {
        let (profile_name, profile) = if let Some(p) = self.profiles.get(target) {
            (target.to_string(), p.clone())
        } else if self.agents.contains_key(target) {
            (
                target.to_string(),
                ProfileDef {
                    agent: target.to_string(),
                    isolate: false,
                    keys: BTreeMap::new(),
                    env: BTreeMap::new(),
                    files: BTreeMap::new(),
                    links: BTreeMap::new(),
                },
            )
        } else {
            bail!("'{target}' is neither a profile nor an agent");
        };

        let agent = self.agents.get(&profile.agent).ok_or_else(|| anyhow!("agent '{}' of profile '{profile_name}' is not defined", profile.agent))?;

        let mut env_set: Vec<(String, String)> = agent.env.clone().into_iter().collect();
        let mut env_summary = Vec::new();
        let mut secrets = Vec::new();

        // Except for the default profile, don't inherit key env vars from the parent
        let env_remove = if profile.keys.is_empty() && !profile.isolate { Vec::new() } else { agent.key_envs.clone() };

        let profile_dir = state_dir.join("profiles").join(&profile_name);
        if profile.isolate {
            let var = agent.config_dir_env.as_ref().ok_or_else(|| anyhow!("agent '{}' has no config_dir_env, so it cannot be isolated", profile.agent))?;
            let dir = profile_dir.clone();
            std::fs::create_dir_all(&dir)?;
            for (rel, content) in &profile.files {
                let rel_path = Path::new(rel);
                if rel_path.is_absolute() || rel_path.components().any(|c| c.as_os_str() == "..") {
                    bail!("files paths must stay inside the profile directory: {rel}");
                }
                let target = dir.join(rel_path);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&target, content)?;
            }
            for (rel, dest) in &profile.links {
                let rel_path = Path::new(rel);
                if rel_path.is_absolute() || rel_path.components().any(|c| c.as_os_str() == "..") {
                    bail!("links paths must stay inside the profile directory: {rel}");
                }
                let dest = match dest.strip_prefix("~/") {
                    Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest),
                    None => PathBuf::from(dest),
                };
                let link = dir.join(rel_path);
                if link.symlink_metadata().is_ok() {
                    std::fs::remove_file(&link)?;
                }
                std::os::unix::fs::symlink(&dest, &link)?;
            }
            env_summary.push(format!("{var}={}", dir.display()));
            env_set.push((var.clone(), dir.display().to_string()));
        }

        for (var, source) in &profile.keys {
            let value = if source == "keychain" {
                keys::get(&profile_name, var)?
            } else if let Some(account) = source.strip_prefix("keychain:") {
                // Share one key across profiles: "keychain:<name>/<VAR>"
                let (p, v) = account.split_once('/').ok_or_else(|| anyhow!("expected the form keychain:<name>/<VAR>: {source}"))?;
                keys::get(p, v)?
            } else if let Some(other) = source.strip_prefix("env:") {
                std::env::var(other).with_context(|| format!("environment variable {other} is not set"))?
            } else {
                bail!("unknown key source '{source}' (keychain / keychain:<name>/<VAR> / env:VAR)");
            };
            env_summary.push(format!("{var}=***({} chars)", value.len()));
            secrets.push(value.clone());
            env_set.push((var.clone(), value));
        }

        for (k, v) in &profile.env {
            let v = &v.replace("{profile_dir}", &profile_dir.display().to_string());
            env_summary.push(format!("{k}={v}"));
            env_set.push((k.clone(), v.clone()));
        }

        Ok(Launch { agent: profile.agent.clone(), command: agent.command.clone(), args: agent.args.clone(), env_set, env_remove, secrets, env_summary })
    }
}

pub fn state_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support/plyfold-probe")
}
