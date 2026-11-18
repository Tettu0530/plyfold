//! The ACP Registry (agentclientprotocol.com/registry): the agents that speak ACP, and how to start them. Plyfold lists
//! them, and adds the ones started through npx or uvx to config.toml as [agents.<id>]. Agents shipped only as binaries
//! are listed but cannot be added yet.
//!
//! Fetched with the system's curl (macOS, Windows 10+ and Linux ship it), so no TLS stack is bundled for this. The last
//! list that arrived is kept in the state directory and used when the network is not there.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use plyfold_profile::AgentDef;
use serde::{Deserialize, Serialize};

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// Icons are fetched only from the registry's own CDN
const ICON_PREFIX: &str = "https://cdn.agentclientprotocol.com/";
/// Registry entries that are Plyfold's built-in agents (already set up, with their own sign-in and key handling)
const BUILT_IN: [(&str, &str); 4] = [("claude-acp", "claude"), ("codex-acp", "codex"), ("gemini", "gemini"), ("opencode", "opencode")];

#[derive(Debug, Deserialize)]
struct Registry {
    agents: Vec<Entry>,
}

#[derive(Debug, Clone, Deserialize)]
struct Entry {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    repository: Option<String>,
    website: Option<String>,
    license: Option<String>,
    icon: Option<String>,
    #[serde(default)]
    distribution: Distribution,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Distribution {
    npx: Option<Package>,
    uvx: Option<Package>,
    // `binary` (per-platform archives) is not read yet: such agents are listed as binary and cannot be added
}

#[derive(Debug, Clone, Deserialize)]
struct Package {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

/// One registry agent as the UI lists it
#[derive(Debug, Serialize)]
pub struct Listed {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub license: Option<String>,
    /// How it is started: "npx", "uvx" or "binary"
    pub kind: &'static str,
    /// Can be added from here (npx or uvx)
    pub addable: bool,
    /// The built-in agent it is, if any
    pub built_in: Option<&'static str>,
    /// The version added to config.toml, if it was
    pub added: Option<String>,
}

fn curl(url: &str) -> Result<Vec<u8>, String> {
    let out = crate::platform::command("curl").args(["-fsSL", "--max-time", "30", "--proto", "=https", url]).output().map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(plyfold_i18n::tr!(
            "ACP Registry を取得できません: {}",
            "Cannot fetch the ACP Registry: {}",
            "无法获取 ACP Registry：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

fn cache_path(state_dir: &Path) -> PathBuf {
    state_dir.join("registry.json")
}

/// The registry, fresh when the network allows, else the copy from the last time
fn load(state_dir: &Path) -> Result<Registry, String> {
    let cache = cache_path(state_dir);
    let (bytes, fresh) = match curl(REGISTRY_URL) {
        Ok(b) => (b, true),
        Err(e) => (std::fs::read(&cache).map_err(|_| e)?, false),
    };
    let reg: Registry = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if fresh {
        let _ = std::fs::write(&cache, &bytes);
    }
    Ok(reg)
}

/// How an entry is started, and whether Plyfold can start it
fn kind(e: &Entry) -> (&'static str, bool) {
    if e.distribution.npx.is_some() {
        ("npx", true)
    } else if e.distribution.uvx.is_some() {
        ("uvx", true)
    } else {
        ("binary", false)
    }
}

pub fn list(state_dir: &Path, agents: &BTreeMap<String, AgentDef>) -> Result<Vec<Listed>, String> {
    let reg = load(state_dir)?;
    let mut out: Vec<Listed> = reg
        .agents
        .into_iter()
        .map(|e| {
            let (kind, addable) = kind(&e);
            let built_in = BUILT_IN.iter().find(|(id, _)| *id == e.id).map(|(_, b)| *b);
            let added = agents.get(&e.id).and_then(|a| a.registry_version.clone());
            Listed {
                id: e.id,
                name: e.name,
                version: e.version,
                description: e.description,
                repository: e.repository,
                website: e.website,
                license: e.license,
                kind,
                addable: addable && built_in.is_none(),
                built_in,
                added,
            }
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// The agent definition for an npx or uvx entry, pinned to the registry's version
fn definition(e: &Entry) -> Option<AgentDef> {
    let (command, mut args, env) = if let Some(p) = &e.distribution.npx {
        // -y: never stop on npx's install prompt (there is no terminal to answer it)
        ("npx", vec!["-y".to_string(), p.package.clone()], p.env.clone())
    } else {
        let p = e.distribution.uvx.as_ref()?;
        ("uvx", vec![p.package.clone()], p.env.clone())
    };
    let p = e.distribution.npx.as_ref().or(e.distribution.uvx.as_ref())?;
    args.extend(p.args.iter().cloned());
    Some(AgentDef {
        command: command.into(),
        args,
        env,
        config_dir_env: None,
        key_envs: vec![],
        name: Some(e.name.clone()),
        registry_version: Some(e.version.clone()),
    })
}

pub fn icon_path(state_dir: &Path, id: &str) -> PathBuf {
    state_dir.join("agent-icons").join(format!("{id}.svg"))
}

/// Add (or update to the registry's version) an agent to config.toml, and keep its icon
pub fn add(state_dir: &Path, config_path: &Path, id: &str) -> Result<(), String> {
    let reg = load(state_dir)?;
    let e = reg
        .agents
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| plyfold_i18n::tr!("ACP Registry に {id} がありません", "{id} is not in the ACP Registry", "ACP Registry 中没有 {id}"))?;
    if BUILT_IN.iter().any(|(rid, _)| *rid == id) {
        return Err(plyfold_i18n::tr!("{id} は組み込み済みです", "{id} is built in", "{id} 已内置"));
    }
    let def = definition(e).ok_or_else(|| {
        plyfold_i18n::tr!(
            "{} はバイナリで配布されているため、まだ対応していません",
            "{} is distributed as a binary, which is not supported yet",
            "{} 以二进制发布，暂不支持",
            e.name
        )
    })?;
    plyfold_profile::edit::upsert_agent(config_path, id, &def).map_err(|e| e.to_string())?;
    // The icon is a nicety: an agent works without it
    if let Some(url) = e.icon.as_deref().filter(|u| u.starts_with(ICON_PREFIX))
        && let Ok(svg) = curl(url)
        && svg.starts_with(b"<")
    {
        let path = icon_path(state_dir, id);
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let _ = std::fs::write(path, svg);
    }
    Ok(())
}

/// Remove an agent added from the registry (only those: built-in and hand-written agents stay)
pub fn remove(state_dir: &Path, config_path: &Path, agents: &BTreeMap<String, AgentDef>, used_by: &[String], id: &str) -> Result<(), String> {
    if agents.get(id).and_then(|a| a.registry_version.as_ref()).is_none() {
        return Err(plyfold_i18n::tr!(
            "{id} は ACP Registry から追加したエージェントではありません",
            "{id} was not added from the ACP Registry",
            "{id} 不是从 ACP Registry 添加的代理"
        ));
    }
    if !used_by.is_empty() {
        return Err(plyfold_i18n::tr!(
            "プロファイル {} がこのエージェントを使っています。先にプロファイルを削除してください",
            "The profile {} uses this agent; delete it first",
            "配置文件 {} 正在使用此代理，请先删除它",
            used_by.join(", ")
        ));
    }
    plyfold_profile::edit::remove_agent(config_path, id).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(icon_path(state_dir, id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: &str) -> Entry {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn npx_and_uvx_become_pinned_agents() {
        let q = entry(
            r#"{"id":"qwen-code","name":"Qwen Code","version":"0.28.0","distribution":{"npx":{"package":"@qwen-code/qwen-code@0.28.0","args":["--acp"]}}}"#,
        );
        let d = definition(&q).unwrap();
        assert_eq!((d.command.as_str(), d.args.clone()), ("npx", vec!["-y".into(), "@qwen-code/qwen-code@0.28.0".into(), "--acp".into()]));
        assert_eq!(d.name.as_deref(), Some("Qwen Code"));
        assert_eq!(d.registry_version.as_deref(), Some("0.28.0"));

        let f = entry(
            r#"{"id":"fast-agent","name":"fast-agent","version":"0.10.1","distribution":{"uvx":{"package":"fast-agent-acp==0.10.1","args":["-x"],"env":{"FAST_AGENT_MODEL":"m"}}}}"#,
        );
        let d = definition(&f).unwrap();
        assert_eq!((d.command.as_str(), d.args.clone()), ("uvx", vec!["fast-agent-acp==0.10.1".into(), "-x".into()]));
        assert_eq!(d.env.get("FAST_AGENT_MODEL").map(String::as_str), Some("m"));
    }

    /// Against the real registry (network): `cargo test -p plyfold-desktop live_registry -- --ignored`
    #[test]
    #[ignore]
    fn live_registry_adds_an_npx_agent() {
        let dir = std::env::temp_dir().join(format!("plyfold-registry-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.toml");
        let listed = list(&dir, &BTreeMap::new()).unwrap();
        assert!(listed.len() > 10);
        assert!(listed.iter().any(|a| a.id == "gemini" && a.built_in == Some("gemini") && !a.addable));
        add(&dir, &config, "qwen-code").unwrap();
        let cfg = plyfold_profile::Config::load(&config).unwrap();
        let q = &cfg.agents["qwen-code"];
        println!("qwen-code: {} {:?} icon={}", q.command, q.args, icon_path(&dir, "qwen-code").exists());
        assert_eq!(q.name.as_deref(), Some("Qwen Code"));
        let again = list(&dir, &cfg.agents).unwrap();
        assert!(again.iter().any(|a| a.id == "qwen-code" && a.added.is_some()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn binaries_are_listed_but_not_added() {
        let g = entry(r#"{"id":"goose","name":"goose","version":"1.60.1","distribution":{"binary":{"darwin-aarch64":{"archive":"a","cmd":"./goose"}}}}"#);
        assert_eq!(kind(&g), ("binary", false));
        assert!(definition(&g).is_none());
    }
}
