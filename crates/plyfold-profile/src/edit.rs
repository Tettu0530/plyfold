//! 画面からプロファイルを編集するための、単純化した形と config.toml の書き換え
//!
//! 画面では「認証の種類・ベース URL・専用ディレクトリ」だけを扱い、
//! エージェントごとの環境変数名や Codex の config.toml の中身はここで決める。
//! 手で書いた項目（default_mode、links など）は、保存しても消さない。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use toml_edit::DocumentMut;

use crate::{Config, ProfileDef, ProfileError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    /// CLI にすでにあるログインをそのまま使う
    Login,
    /// 公式 API にキーで接続する
    Api,
    /// カスタムプロバイダー（ベース URL + キー）
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
}

/// エージェントごとの、キーとベース URL の渡し方
struct AuthSpec {
    api_key: &'static str,
    custom_key: &'static str,
    /// None なら、ベース URL は Codex の config.toml に書く
    custom_base: Option<&'static str>,
}

/// Codex のカスタムプロバイダーのキーを渡す環境変数（config.toml の env_key）
const CODEX_PROVIDER_KEY: &str = "PLYFOLD_PROVIDER_KEY";

fn spec(agent: &str) -> Option<AuthSpec> {
    match agent {
        "claude" => Some(AuthSpec { api_key: "ANTHROPIC_API_KEY", custom_key: "ANTHROPIC_AUTH_TOKEN", custom_base: Some("ANTHROPIC_BASE_URL") }),
        "codex" => Some(AuthSpec { api_key: "OPENAI_API_KEY", custom_key: CODEX_PROVIDER_KEY, custom_base: None }),
        "gemini" => Some(AuthSpec { api_key: "GEMINI_API_KEY", custom_key: "GEMINI_API_KEY", custom_base: Some("GOOGLE_GEMINI_BASE_URL") }),
        _ => None,
    }
}

/// このエージェントで選べる認証の種類
pub fn supported_auth(agent: &str) -> Vec<AuthKind> {
    match spec(agent) {
        Some(_) => vec![AuthKind::Login, AuthKind::Api, AuthKind::Custom],
        None => vec![AuthKind::Login],
    }
}

/// キーを渡す環境変数（ログインなら None）
pub fn key_var(agent: &str, auth: AuthKind) -> Option<&'static str> {
    let s = spec(agent)?;
    match auth {
        AuthKind::Login => None,
        AuthKind::Api => Some(s.api_key),
        AuthKind::Custom => Some(s.custom_key),
    }
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

/// 保存されている定義を、画面の形にする
pub fn describe(name: &str, def: &ProfileDef) -> ProfileForm {
    let base = |var: Option<&str>| match var {
        Some(v) => def.env.get(v).cloned(),
        None => codex_base_url(&def.files),
    };
    let (auth, base_url) = match spec(&def.agent) {
        Some(s) if def.keys.contains_key(s.custom_key) && base(s.custom_base).is_some() => (AuthKind::Custom, base(s.custom_base)),
        Some(s) if def.keys.contains_key(s.api_key) => (AuthKind::Api, None),
        _ => (AuthKind::Login, None),
    };
    ProfileForm { name: name.into(), agent: def.agent.clone(), label: def.label.clone(), auth, base_url, isolate: def.isolate }
}

/// 画面の形から定義を作る。既にある定義の、画面で扱わない項目は残す
pub fn to_def(form: &ProfileForm, existing: Option<&ProfileDef>) -> Result<ProfileDef, ProfileError> {
    let mut def = existing.cloned().unwrap_or_default();
    let changed_agent = def.agent != form.agent;
    def.agent = form.agent.clone();
    def.label = form.label.clone().filter(|l| !l.trim().is_empty());
    def.isolate = form.isolate;

    let s = spec(&form.agent);
    if form.auth != AuthKind::Login && s.is_none() {
        return Err(ProfileError::Form(format!("{} はキーでの接続に対応していません", form.agent)));
    }
    // 画面で扱う変数だけを入れ替える（ほかの変数はそのまま）
    let all_key_vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", CODEX_PROVIDER_KEY];
    let all_base_vars = ["ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL"];
    let old_keys = std::mem::take(&mut def.keys);
    let keep_source = |var: &str| old_keys.get(var).filter(|_| !changed_agent).cloned().unwrap_or_else(|| "keychain".into());
    for (k, v) in &old_keys {
        if !all_key_vars.contains(&k.as_str()) {
            def.keys.insert(k.clone(), v.clone());
        }
    }
    for v in all_base_vars {
        def.env.remove(v);
    }
    if def.agent == "codex" || changed_agent {
        def.files.remove("config.toml");
    }

    if let (Some(s), Some(var)) = (s, key_var(&form.agent, form.auth)) {
        def.keys.insert(var.into(), keep_source(var));
        if form.auth == AuthKind::Custom {
            let url = form.base_url.as_deref().map(str::trim).filter(|u| !u.is_empty()).ok_or_else(|| ProfileError::Form("ベース URL を入力してください".into()))?;
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(ProfileError::Form("ベース URL は http:// か https:// で始めてください".into()));
            }
            match s.custom_base {
                Some(env) => {
                    def.env.insert(env.into(), url.into());
                }
                None => {
                    // Codex はプロバイダーを config.toml に書くので、専用ディレクトリが要る
                    def.isolate = true;
                    def.files.insert("config.toml".into(), codex_provider_toml(url));
                }
            }
        }
    }
    Ok(def)
}

/// キーチェーンのアカウント名（"keychain" → "<プロファイル>/<変数>"、"keychain:<名前>" → "<名前>"）
pub fn key_account(name: &str, def: &ProfileDef) -> Option<(String, String)> {
    let form = describe(name, def);
    let var = key_var(&def.agent, form.auth)?;
    let source = def.keys.get(var)?;
    let account = if source == "keychain" { format!("{name}/{var}") } else { source.strip_prefix("keychain:")?.to_string() };
    Some((var.into(), account))
}

/// プロファイル名に使える文字（ディレクトリ名とキーチェーンのアカウント名になる）
pub fn validate_name(name: &str, config: &Config) -> Result<(), ProfileError> {
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ProfileError::Form("名前は英数字と - _ だけで、40 文字までにしてください".into()));
    }
    if config.agents.contains_key(name) {
        return Err(ProfileError::Form(format!("'{name}' はエージェントの名前なので使えません")));
    }
    Ok(())
}

fn read_doc(path: &Path) -> Result<DocumentMut, ProfileError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    text.parse::<DocumentMut>().map_err(|e| ProfileError::Form(format!("設定ファイルの形式が不正です: {e}")))
}

fn write_doc(path: &Path, doc: &DocumentMut) -> Result<(), ProfileError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // 途中で落ちても壊れないように、別のファイルに書いてから置き換える
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string())?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// config.toml の [profiles.<name>] を書き換える（ほかの部分とコメントは残す）
pub fn upsert_profile(path: &Path, name: &str, def: &ProfileDef) -> Result<(), ProfileError> {
    let mut doc = read_doc(path)?;
    let value = toml_edit::ser::to_document(def).map_err(|e| ProfileError::Form(e.to_string()))?;
    if !doc.contains_key("profiles") {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        doc["profiles"] = toml_edit::Item::Table(t);
    }
    let profiles = doc["profiles"].as_table_mut().ok_or_else(|| ProfileError::Form("profiles が表ではありません".into()))?;
    let mut table = value.as_table().clone();
    for (_, item) in table.iter_mut() {
        if let Some(t) = item.as_table_mut() {
            t.set_implicit(false);
        }
    }
    profiles[name] = toml_edit::Item::Table(table);
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
        ProfileForm { name: "p".into(), agent: agent.into(), label: None, auth, base_url: url.map(str::to_string), isolate: true }
    }

    #[test]
    fn round_trips_each_auth() {
        for agent in ["claude", "codex", "gemini"] {
            for (auth, url) in [(AuthKind::Login, None), (AuthKind::Api, None), (AuthKind::Custom, Some("https://gw.example.com/v1"))] {
                let f = form(agent, auth, url);
                let def = to_def(&f, None).unwrap();
                assert_eq!(describe("p", &def), f, "{agent} {auth:?}");
            }
        }
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
        // 同じ変数なら共有のキーの指定を保つ
        let back = to_def(&form("claude", AuthKind::Api, None), Some(&old)).unwrap();
        assert_eq!(back.keys.get("ANTHROPIC_API_KEY").map(String::as_str), Some("keychain:shared/KEY"));
        assert_eq!(key_account("p", &back), Some(("ANTHROPIC_API_KEY".into(), "shared/KEY".into())));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(to_def(&form("claude", AuthKind::Custom, None), None).is_err());
        assert!(to_def(&form("claude", AuthKind::Custom, Some("gw.example.com")), None).is_err());
        assert!(to_def(&form("opencode", AuthKind::Api, None), None).is_err());
        let cfg = Config::from_toml("").unwrap();
        assert!(validate_name("work", &cfg).is_ok());
        assert!(validate_name("claude", &cfg).is_err());
        assert!(validate_name("../x", &cfg).is_err());
    }

    #[test]
    fn edits_file_and_keeps_comments() {
        let dir = std::env::temp_dir().join(format!("plyfold-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "# 手で書いたメモ\n[profiles.keep]\nagent = \"claude\"\n").unwrap();
        let def = to_def(&form("codex", AuthKind::Custom, Some("https://gw.example.com/v1")), None).unwrap();
        upsert_profile(&path, "proxy", &def).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# 手で書いたメモ"));
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.profiles["proxy"], def);
        assert!(cfg.profiles.contains_key("keep"));
        remove_profile(&path, "proxy").unwrap();
        let cfg = Config::load(&path).unwrap();
        assert!(!cfg.profiles.contains_key("proxy"));
        assert!(cfg.profiles.contains_key("keep"));
    }
}
