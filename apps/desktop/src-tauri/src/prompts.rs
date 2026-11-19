//! Saved prompts, in `prompts.json` in the state directory. A development build and the installed app share the file
//! (it is not under the development data folder). A file that is not this shape is left as it is.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_PROMPTS: usize = 200;
const MAX_NAME: usize = 80;
const MAX_BODY: usize = 20_000;
const MAX_REPO: usize = 1_024;
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Prompt {
    pub id: String,
    pub name: String,
    pub body: String,
    #[serde(default)]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct File {
    prompts: Vec<Prompt>,
}

fn file_path(state_dir: &Path) -> PathBuf {
    state_dir.join("prompts.json")
}

fn bad_file() -> String {
    plyfold_i18n::tr!(
        "このファイルは保存したプロンプトの形ではありません。中身は変えていません",
        "This file is not a saved-prompt file. Nothing was changed",
        "这个文件不是已保存提示词的格式。内容未更改"
    )
}

fn too_big() -> String {
    plyfold_i18n::tr!("ファイルが大きすぎます。中身は変えていません", "The file is too large. Nothing was changed", "文件过大。内容未更改")
}

/// Missing file is an empty library. A file that does not parse is an error (it is not overwritten)
pub fn load(state_dir: &Path) -> Result<Vec<Prompt>, String> {
    let path = file_path(state_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    if text.len() > MAX_BYTES {
        return Err(too_big());
    }
    let file: File = serde_json::from_str(&text).map_err(|_| bad_file())?;
    check_all(&file.prompts)
}

pub fn save(state_dir: &Path, prompt: Prompt) -> Result<Vec<Prompt>, String> {
    let prompt = normalize(prompt)?;
    let mut prompts = load(state_dir)?;
    match prompts.iter().position(|p| p.id == prompt.id) {
        Some(i) => prompts[i] = prompt,
        None => {
            if prompts.len() >= MAX_PROMPTS {
                return Err(plyfold_i18n::tr!("保存したプロンプトは {} 件までです", "At most {} saved prompts", "最多保存 {} 条提示词", MAX_PROMPTS));
            }
            prompts.push(prompt);
        }
    }
    write(state_dir, &prompts)?;
    Ok(prompts)
}

pub fn delete(state_dir: &Path, id: &str) -> Result<Vec<Prompt>, String> {
    let mut prompts = load(state_dir)?;
    let before = prompts.len();
    prompts.retain(|p| p.id != id);
    if prompts.len() == before {
        return Err(plyfold_i18n::tr!("そのプロンプトは見つかりません", "That prompt was not found", "找不到该提示词"));
    }
    write(state_dir, &prompts)?;
    Ok(prompts)
}

pub fn export_json(state_dir: &Path) -> Result<String, String> {
    let prompts = load(state_dir)?;
    serde_json::to_string_pretty(&File { prompts }).map_err(|e| e.to_string())
}

/// Write the library to a path the user chose. The library file itself is not changed
pub fn export_to(state_dir: &Path, dest: &Path) -> Result<(), String> {
    if dest.as_os_str().is_empty() || dest.is_dir() {
        return Err(bad_file());
    }
    let json = export_json(state_dir)?;
    atomic_write(dest, json.as_bytes())
}

/// Add the prompts in this JSON, or replace one that has the same id. A file that does not fit is not applied
pub fn import_text(state_dir: &Path, text: &str) -> Result<Vec<Prompt>, String> {
    if text.len() > MAX_BYTES {
        return Err(too_big());
    }
    let incoming: File = serde_json::from_str(text).map_err(|_| bad_file())?;
    let incoming = check_all(&incoming.prompts)?;
    let mut prompts = load(state_dir)?;
    for prompt in incoming {
        match prompts.iter().position(|p| p.id == prompt.id) {
            Some(i) => prompts[i] = prompt,
            None => prompts.push(prompt),
        }
    }
    if prompts.len() > MAX_PROMPTS {
        return Err(plyfold_i18n::tr!(
            "読み込むと {} 件を超えます。中身は変えていません",
            "Reading this in would pass {} prompts. Nothing was changed",
            "读入后将超过 {} 条。内容未更改",
            MAX_PROMPTS
        ));
    }
    write(state_dir, &prompts)?;
    Ok(prompts)
}

pub fn import_file(state_dir: &Path, src: &Path) -> Result<Vec<Prompt>, String> {
    let meta = std::fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() || meta.len() > MAX_BYTES as u64 {
        return Err(if meta.len() > MAX_BYTES as u64 { too_big() } else { bad_file() });
    }
    let text = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    import_text(state_dir, &text)
}

fn check_all(prompts: &[Prompt]) -> Result<Vec<Prompt>, String> {
    if prompts.len() > MAX_PROMPTS {
        return Err(plyfold_i18n::tr!("保存したプロンプトは {} 件までです", "At most {} saved prompts", "最多保存 {} 条提示词", MAX_PROMPTS));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(prompts.len());
    for prompt in prompts {
        let prompt = normalize(prompt.clone())?;
        if !seen.insert(prompt.id.clone()) {
            return Err(plyfold_i18n::tr!(
                "同じ id のプロンプトが 2 つあります。中身は変えていません",
                "Two prompts use the same id. Nothing was changed",
                "有两条提示词使用了相同的 id。内容未更改"
            ));
        }
        out.push(prompt);
    }
    Ok(out)
}

fn normalize(mut prompt: Prompt) -> Result<Prompt, String> {
    prompt.id = prompt.id.trim().to_string();
    prompt.name = prompt.name.trim().to_string();
    prompt.body = prompt.body.trim().to_string();
    prompt.repo = prompt.repo.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    if !valid_id(&prompt.id) {
        return Err(bad_file());
    }
    if prompt.name.is_empty() || prompt.name.chars().count() > MAX_NAME {
        return Err(plyfold_i18n::tr!("名前は 1 字から {} 字までです", "The name must be 1 to {} characters", "名称须为 1 到 {} 个字符", MAX_NAME));
    }
    if prompt.body.is_empty() || prompt.body.chars().count() > MAX_BODY {
        return Err(plyfold_i18n::tr!("本文は 1 字から {} 字までです", "The prompt must be 1 to {} characters", "提示词须为 1 到 {} 个字符", MAX_BODY));
    }
    if prompt.repo.as_ref().is_some_and(|r| r.chars().count() > MAX_REPO) {
        return Err(plyfold_i18n::tr!("リポジトリのパスが長すぎます", "The repository path is too long", "仓库路径过长"));
    }
    if prompt.name.contains('\0') || prompt.body.contains('\0') || prompt.repo.as_ref().is_some_and(|r| r.contains('\0')) {
        return Err(bad_file());
    }
    Ok(prompt)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn write(state_dir: &Path, prompts: &[Prompt]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&File { prompts: prompts.to_vec() }).map_err(|e| e.to_string())?;
    atomic_write(&file_path(state_dir), json.as_bytes())
}

fn atomic_write(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_file_name(format!(".prompts.{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-prompts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn prompt(id: &str, name: &str, body: &str, repo: Option<&str>) -> Prompt {
        Prompt { id: id.into(), name: name.into(), body: body.into(), repo: repo.map(str::to_string) }
    }

    #[test]
    fn a_missing_file_is_an_empty_library() {
        let dir = tmp("empty");
        assert_eq!(load(&dir).unwrap(), Vec::<Prompt>::new());
    }

    #[test]
    fn save_lists_updates_and_deletes() {
        let dir = tmp("save");
        let saved = save(&dir, prompt("one", "  Fix  ", "  look at this  ", Some("  "))).unwrap();
        assert_eq!(saved, vec![prompt("one", "Fix", "look at this", None)]);
        let updated = save(&dir, prompt("one", "Fix tests", "run them", Some("/repo"))).unwrap();
        assert_eq!(updated, vec![prompt("one", "Fix tests", "run them", Some("/repo"))]);
        assert_eq!(load(&dir).unwrap(), updated);
        assert_eq!(delete(&dir, "one").unwrap(), Vec::<Prompt>::new());
        assert!(delete(&dir, "one").is_err());
    }

    #[test]
    fn a_broken_file_is_not_replaced() {
        let dir = tmp("broken");
        let path = file_path(&dir);
        std::fs::write(&path, "{").unwrap();
        assert!(load(&dir).is_err());
        assert!(save(&dir, prompt("one", "Name", "Body", None)).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{");
        assert!(import_text(&dir, r#"{"prompts":[{"id":"one","name":"Name","body":"Body"}]}"#).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{");
    }

    #[test]
    fn import_merges_by_id_and_rejects_a_bad_shape() {
        let dir = tmp("import");
        save(&dir, prompt("keep", "Keep", "stay", None)).unwrap();
        let text = r#"{"prompts":[
            {"id":"keep","name":"Kept","body":"replaced"},
            {"id":"new-1","name":"New","body":"added","repo":"/work"}
        ]}"#;
        let merged = import_text(&dir, text).unwrap();
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].body, "replaced");
        assert_eq!(merged[1].repo.as_deref(), Some("/work"));
        assert!(import_text(&dir, r#"{"prompts":[{"id":"a","name":"A","body":"B"},{"id":"a","name":"C","body":"D"}]}"#).is_err());
        assert_eq!(load(&dir).unwrap().len(), 2);
        assert!(import_text(&dir, "[1, 2]").is_err());
        assert!(import_text(&dir, r#"{"prompts":[{"id":"bad id","name":"A","body":"B"}]}"#).is_err());
        assert_eq!(load(&dir).unwrap().len(), 2);
    }

    #[test]
    fn export_roundtrips_and_a_symlink_is_not_imported() {
        let dir = tmp("export");
        save(&dir, prompt("one", "Name", "Body", None)).unwrap();
        let dest = dir.join("out.json");
        export_to(&dir, &dest).unwrap();
        let other = tmp("export-in");
        let imported = import_file(&other, &dest).unwrap();
        assert_eq!(imported, load(&dir).unwrap());

        #[cfg(unix)]
        {
            let link = dir.join("link.json");
            std::os::unix::fs::symlink(&dest, &link).unwrap();
            assert!(import_file(&other, &link).is_err());
            assert_eq!(load(&other).unwrap(), imported);
        }
    }
}
