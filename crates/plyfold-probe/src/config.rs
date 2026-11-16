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
    /// isolate したディレクトリに置くファイル（相対パス = 中身）。Codex の config.toml など
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// isolate したディレクトリに張るシンボリックリンク（相対パス = リンク先。~ 可）。
    /// ログイン情報は複製するとトークンの更新でぶつかるので、リンクで共有する
    #[serde(default)]
    pub links: BTreeMap<String, String>,
}

/// 1 回の起動に必要なものを解決したもの
#[derive(Debug, Clone)]
pub struct Launch {
    pub agent: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    /// ログに出してはいけない値
    pub secrets: Vec<String>,
    /// 表示用（値は伏せる）
    pub env_summary: Vec<String>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("設定ファイルを読めません: {}", path.display()))?;
        let mut cfg: Config =
            toml::from_str(&text).with_context(|| format!("設定ファイルの形式が不正です: {}", path.display()))?;

        // 同じ場所の *.local.toml（git に入れない）があれば上書きで足す
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
            let o: Overlay = toml::from_str(&text)
                .with_context(|| format!("設定ファイルの形式が不正です: {}", local.display()))?;
            cfg.agents.extend(o.agents);
            cfg.profiles.extend(o.profiles);
        }
        Ok(cfg)
    }

    /// target はプロファイル名かエージェント名
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
            bail!("'{target}' はプロファイルにもエージェントにもありません");
        };

        let agent = self
            .agents
            .get(&profile.agent)
            .ok_or_else(|| anyhow!("プロファイル '{profile_name}' のエージェント '{}' が未定義です", profile.agent))?;

        let mut env_set: Vec<(String, String)> = agent.env.clone().into_iter().collect();
        let mut env_summary = Vec::new();
        let mut secrets = Vec::new();

        // 既定プロファイル以外では、キー系の環境変数を親から引き継がない
        let env_remove = if profile.keys.is_empty() && !profile.isolate {
            Vec::new()
        } else {
            agent.key_envs.clone()
        };

        let profile_dir = state_dir.join("profiles").join(&profile_name);
        if profile.isolate {
            let var = agent.config_dir_env.as_ref().ok_or_else(|| {
                anyhow!("エージェント '{}' は config_dir_env が未設定なので isolate できません", profile.agent)
            })?;
            let dir = profile_dir.clone();
            std::fs::create_dir_all(&dir)?;
            for (rel, content) in &profile.files {
                let rel_path = Path::new(rel);
                if rel_path.is_absolute() || rel_path.components().any(|c| c.as_os_str() == "..") {
                    bail!("files のパスはプロファイルのディレクトリの中に限ります: {rel}");
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
                    bail!("links のパスはプロファイルのディレクトリの中に限ります: {rel}");
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
                // 複数のプロファイルで同じキーを使う: "keychain:<名前>/<変数名>"
                let (p, v) = account
                    .split_once('/')
                    .ok_or_else(|| anyhow!("keychain:<名前>/<変数名> の形で指定してください: {source}"))?;
                keys::get(p, v)?
            } else if let Some(other) = source.strip_prefix("env:") {
                std::env::var(other).with_context(|| format!("環境変数 {other} がありません"))?
            } else {
                bail!("キーの取得元 '{source}' は不明です（keychain / keychain:<名前>/<変数名> / env:VAR）");
            };
            env_summary.push(format!("{var}=***({}文字)", value.len()));
            secrets.push(value.clone());
            env_set.push((var.clone(), value));
        }

        for (k, v) in &profile.env {
            let v = &v.replace("{profile_dir}", &profile_dir.display().to_string());
            env_summary.push(format!("{k}={v}"));
            env_set.push((k.clone(), v.clone()));
        }

        Ok(Launch {
            agent: profile.agent.clone(),
            command: agent.command.clone(),
            args: agent.args.clone(),
            env_set,
            env_remove,
            secrets,
            env_summary,
        })
    }
}

pub fn state_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support/plyfold-probe")
}
