//! The ACP Registry (agentclientprotocol.com/registry): the agents that speak ACP, and how to start them. Plyfold lists
//! them, and adds them to config.toml as [agents.<id>]: npx and uvx packages pinned to the registry's version, and
//! binaries downloaded for this system, checked against the registry's sha256 and unpacked under
//! `<state>/agents/<id>/<version>`. A binary without a checksum, or without a build for this system, is not added.
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
    /// Per system ("darwin-aarch64", "linux-x86_64", "windows-x86_64", ...)
    #[serde(default)]
    binary: BTreeMap<String, Binary>,
}

#[derive(Debug, Clone, Deserialize)]
struct Binary {
    /// An archive (.tar.gz, .tar.bz2, .tar.xz, .zip) or the program itself
    archive: String,
    /// The program, relative to the unpacked archive
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    sha256: Option<String>,
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
    /// Can be added from here
    pub addable: bool,
    /// Why a binary cannot be added: "platform" (no build for this system) or "checksum" (no sha256 to check it with)
    pub unavailable: Option<&'static str>,
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

/// How an entry is started, and why Plyfold cannot add it, if it cannot
fn kind(e: &Entry) -> (&'static str, Option<&'static str>) {
    if e.distribution.npx.is_some() {
        ("npx", None)
    } else if e.distribution.uvx.is_some() {
        ("uvx", None)
    } else {
        match binary_for_this_system(e) {
            None => ("binary", Some("platform")),
            Some(b) if b.sha256.as_deref().is_none_or(|s| s.len() != 64) => ("binary", Some("checksum")),
            Some(_) => ("binary", None),
        }
    }
}

/// The registry's names for this system: os-arch, then the musl build on Linux
fn platform_keys() -> Vec<String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let key = format!("{os}-{}", std::env::consts::ARCH);
    if os == "linux" { vec![key.clone(), format!("{key}-musl")] } else { vec![key] }
}

fn binary_for_this_system(e: &Entry) -> Option<&Binary> {
    platform_keys().iter().find_map(|k| e.distribution.binary.get(k))
}

pub fn list(state_dir: &Path, agents: &BTreeMap<String, AgentDef>) -> Result<Vec<Listed>, String> {
    let reg = load(state_dir)?;
    let mut out: Vec<Listed> = reg
        .agents
        .into_iter()
        .map(|e| {
            let (kind, unavailable) = kind(&e);
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
                addable: unavailable.is_none() && built_in.is_none(),
                unavailable,
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

/// An id that is a plain folder name (it names the install folder)
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+')) && !id.starts_with('.')
}

/// Download this system's build of a binary agent, check it against the registry's sha256, unpack it under
/// `<state>/agents/<id>/<version>`, and return its definition (the program by its full path)
fn install_binary(state_dir: &Path, e: &Entry) -> Result<AgentDef, String> {
    let b = binary_for_this_system(e)
        .ok_or_else(|| plyfold_i18n::tr!("{} にはこのシステム向けの版がありません", "{} has no build for this system", "{} 没有适用于此系统的版本", e.name))?;
    let sha = b.sha256.as_deref().filter(|s| s.len() == 64).ok_or_else(|| {
        plyfold_i18n::tr!(
            "{} はチェックサムが公開されていないため、確かめられないので追加しません",
            "{} publishes no checksum, so it cannot be checked and is not added",
            "{} 未公开校验和，无法验证，因此不添加",
            e.name
        )
    })?;
    if !safe_id(&e.id) || !safe_id(&e.version) {
        return Err(plyfold_i18n::tr!("{} の名前か版が不正です", "{}'s id or version is not valid", "{} 的 ID 或版本无效", e.name));
    }
    if !b.archive.starts_with("https://") {
        return Err(plyfold_i18n::tr!("{} の配布先が https ではありません", "{} is not served over https", "{} 不是通过 https 提供的", e.name));
    }
    let root = state_dir.join("agents");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let work = root.join(format!(".download-{}-{}", e.id, std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let file = work.join("download");
        let out = crate::platform::command("curl")
            .args(["-fsSL", "--max-time", "900", "--proto", "=https", "--proto-redir", "=https", "-o"])
            .arg(&file)
            .arg(&b.archive)
            .output()
            .map_err(|e| format!("curl: {e}"))?;
        if !out.status.success() {
            return Err(plyfold_i18n::tr!(
                "{} をダウンロードできません: {}",
                "Cannot download {}: {}",
                "无法下载 {}：{}",
                e.name,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let unpacked = work.join("unpacked");
        let program = unpack_checked(&file, &b.archive, sha, &b.cmd, &unpacked)?;
        let dest = root.join(&e.id).join(&e.version);
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::rename(&unpacked, &dest).map_err(|e| e.to_string())?;
        // Older versions of this agent are no longer named in config.toml
        if let Ok(entries) = std::fs::read_dir(root.join(&e.id)) {
            for old in entries.flatten().filter(|d| d.file_name() != e.version.as_str()) {
                let _ = std::fs::remove_dir_all(old.path());
            }
        }
        Ok(dest.join(program.strip_prefix(&unpacked).map_err(|e| e.to_string())?))
    })();
    let _ = std::fs::remove_dir_all(&work);
    let program = result?;
    Ok(AgentDef {
        command: program.display().to_string(),
        args: b.args.clone(),
        env: b.env.clone(),
        config_dir_env: None,
        key_envs: vec![],
        name: Some(e.name.clone()),
        registry_version: Some(e.version.clone()),
    })
}

/// Check `file` against `sha256`, unpack it into `into` and return the program's path there. Nothing is unpacked from a
/// file that does not match, and the program must lie inside `into` (no `..`, no link leading out)
fn unpack_checked(file: &Path, archive_url: &str, sha256: &str, cmd: &str, into: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let got: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(sha256) {
        return Err(plyfold_i18n::tr!(
            "ダウンロードしたファイルのチェックサムが一致しません（壊れているか、差し替えられています）",
            "The downloaded file does not match its checksum (it is damaged or was replaced)",
            "下载的文件与校验和不一致（文件已损坏或被替换）"
        ));
    }
    drop(bytes);
    let rel = program_path(cmd)
        .ok_or_else(|| plyfold_i18n::tr!("起動するファイルの場所が不正です: {cmd}", "The program path is not valid: {cmd}", "程序路径无效：{cmd}"))?;
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let name = archive_url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let tarball = [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar"].iter().any(|x| name.ends_with(x));
    if tarball || name.ends_with(".zip") {
        let mut cmd = if name.ends_with(".zip") && cfg!(target_os = "linux") {
            // GNU tar does not read zip
            let mut c = crate::platform::command("unzip");
            c.arg("-q").arg(file).arg("-d").arg(into);
            c
        } else {
            // bsdtar on macOS and Windows reads zip as well; it refuses absolute and .. paths
            let mut c = crate::platform::command("tar");
            c.arg("-xf").arg(file).arg("-C").arg(into);
            c
        };
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(plyfold_i18n::tr!("展開できません: {}", "Cannot unpack: {}", "无法解压：{}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    } else {
        // The program itself
        let dest = into.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(file, &dest).map_err(|e| e.to_string())?;
    }
    let base = into.canonicalize().map_err(|e| e.to_string())?;
    let program = into.join(&rel);
    let real = program
        .canonicalize()
        .map_err(|_| plyfold_i18n::tr!("展開したものに {cmd} がありません", "{cmd} is not in what was unpacked", "解压内容中没有 {cmd}"))?;
    if !real.starts_with(&base) || !real.is_file() {
        return Err(plyfold_i18n::tr!("起動するファイルの場所が不正です: {cmd}", "The program path is not valid: {cmd}", "程序路径无效：{cmd}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(&real).map_err(|e| e.to_string())?.permissions();
        perm.set_mode(perm.mode() | 0o755);
        std::fs::set_permissions(&real, perm).map_err(|e| e.to_string())?;
    }
    Ok(program)
}

/// The registry's `cmd` ("./bin/tool", "./dist\\tool.exe") as a relative path; None if it would leave the folder
fn program_path(cmd: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in cmd.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => return None,
            p if p.contains(':') => return None,
            p => out.push(p),
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
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
    let def = match definition(e) {
        Some(def) => def,
        None => install_binary(state_dir, e)?,
    };
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
    // A downloaded binary goes with it (a running session keeps its open file on Unix; on Windows the folder stays)
    if safe_id(id) {
        let _ = std::fs::remove_dir_all(state_dir.join("agents").join(id));
    }
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

    fn sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn a_binary_needs_a_build_for_this_system_and_a_checksum() {
        let here = platform_keys()[0].clone();
        let with = |key: &str, sha: &str| {
            entry(&format!(
                r#"{{"id":"goose","name":"goose","version":"1.60.1","distribution":{{"binary":{{"{key}":{{"archive":"https://x/a.tar.gz","cmd":"./goose"{sha}}}}}}}}}"#
            ))
        };
        assert_eq!(kind(&with("plan9-mips", "")), ("binary", Some("platform")));
        assert_eq!(kind(&with(&here, "")), ("binary", Some("checksum")));
        assert_eq!(kind(&with(&here, &format!(r#","sha256":"{}""#, "a".repeat(64)))), ("binary", None));
        assert!(definition(&with(&here, "")).is_none(), "npx and uvx only");
    }

    #[test]
    fn program_paths_stay_inside() {
        assert_eq!(program_path("./bin/tool"), Some(PathBuf::from("bin").join("tool")));
        assert_eq!(program_path("./dist\\tool.exe"), Some(PathBuf::from("dist").join("tool.exe")));
        assert_eq!(program_path("tool"), Some(PathBuf::from("tool")));
        assert_eq!(program_path("../tool"), None);
        assert_eq!(program_path("./a/../../tool"), None);
        assert_eq!(program_path("C:\\tool.exe"), None);
        assert_eq!(program_path("./"), None);
    }

    #[cfg(unix)]
    #[test]
    fn an_archive_is_unpacked_only_when_its_checksum_matches() {
        let dir = std::env::temp_dir().join(format!("plyfold-registry-bin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src");
        std::fs::create_dir_all(src.join("bin")).unwrap();
        std::fs::write(src.join("bin/tool"), "#!/bin/sh\necho hi\n").unwrap();
        let archive = dir.join("tool.tar.gz");
        assert!(std::process::Command::new("tar").arg("-czf").arg(&archive).arg("-C").arg(&src).arg(".").status().unwrap().success());
        let bytes = std::fs::read(&archive).unwrap();

        let bad = unpack_checked(&archive, "https://x/tool.tar.gz", &"0".repeat(64), "./bin/tool", &dir.join("bad"));
        assert!(bad.is_err());
        assert!(!dir.join("bad/bin/tool").exists(), "nothing unpacked from a file that does not match");

        let p = unpack_checked(&archive, "https://x/tool.tar.gz?x=1", &sha(&bytes).to_uppercase(), "./bin/tool", &dir.join("ok")).unwrap();
        assert!(p.ends_with("bin/tool") && p.is_file());
        use std::os::unix::fs::PermissionsExt;
        assert!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o111 != 0, "made executable");

        assert!(unpack_checked(&archive, "https://x/tool.tar.gz", &sha(&bytes), "./bin/missing", &dir.join("missing")).is_err());

        // A program served as is
        let raw = dir.join("raw");
        std::fs::write(&raw, "#!/bin/sh\n").unwrap();
        let raw_sha = sha(&std::fs::read(&raw).unwrap());
        let p = unpack_checked(&raw, "https://x/download?file=muse", &raw_sha, "./muse", &dir.join("raw-out")).unwrap();
        assert!(p.ends_with("muse") && p.is_file());

        // A link in the archive that leads out does not count as the program
        let evil = dir.join("evil");
        std::fs::create_dir_all(&evil).unwrap();
        std::os::unix::fs::symlink("/bin/sh", evil.join("tool")).unwrap();
        let evil_tar = dir.join("evil.tar.gz");
        assert!(std::process::Command::new("tar").arg("-czf").arg(&evil_tar).arg("-C").arg(&evil).arg(".").status().unwrap().success());
        let evil_sha = sha(&std::fs::read(&evil_tar).unwrap());
        assert!(unpack_checked(&evil_tar, "https://x/evil.tar.gz", &evil_sha, "./tool", &dir.join("evil-out")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
