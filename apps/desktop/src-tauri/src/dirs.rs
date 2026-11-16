//! リポジトリを選ぶ欄の補完: 入力の途中のパスから、続きになるフォルダを返す
//!
//! - `~/pro` → `~/projects` など（大文字小文字は区別しない）。`~/projects/` なら中のフォルダ
//! - 隠しフォルダは、名前を `.` から打ったときだけ出す
//! - git のリポジトリ（.git がある）には印を付けて先に並べる

use std::path::{Path, PathBuf};

use serde::Serialize;

const LIMIT: usize = 40;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DirCandidate {
    /// 表示と入力に使うパス（ホームの下は ~ で書く）
    pub path: String,
    pub name: String,
    pub git: bool,
}

fn expand(input: &str, home: &Path) -> PathBuf {
    if input == "~" {
        return home.to_path_buf();
    }
    match input.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(input),
    }
}

fn shorten(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

pub fn is_git(path: &Path) -> bool {
    path.join(".git").exists()
}

pub fn complete(input: &str, home: &Path) -> Vec<DirCandidate> {
    let input = input.trim();
    if input.is_empty() {
        return Vec::new();
    }
    let full = expand(input, home);
    let (parent, stem) = if input.ends_with('/') || input == "~" {
        (full, String::new())
    } else {
        let stem = full.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        (full.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/")), stem)
    };
    let Ok(read) = std::fs::read_dir(&parent) else { return Vec::new() };
    let mut out: Vec<DirCandidate> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && !stem.starts_with('.') {
                return None;
            }
            if !name.to_lowercase().starts_with(&stem) {
                return None;
            }
            let path = e.path();
            // シンボリックリンクの先がフォルダなら入れる
            if !path.is_dir() {
                return None;
            }
            Some(DirCandidate { git: is_git(&path), path: shorten(&path, home), name })
        })
        .collect();
    out.sort_by(|a, b| b.git.cmp(&a.git).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out.truncate(LIMIT);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-dirs-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        for p in ["projects/plyfold/.git", "projects/Pebrel", "projects/tsumiki/.git", "Pictures", ".config"] {
            std::fs::create_dir_all(d.join(p)).unwrap();
        }
        std::fs::write(d.join("projects/notes.txt"), "x").unwrap();
        d
    }

    #[test]
    fn completes_names_under_home_with_tilde() {
        let home = tree();
        let got = complete("~/p", &home);
        assert_eq!(got.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["~/Pictures", "~/projects"]);
    }

    #[test]
    fn lists_children_after_a_slash_with_git_first_and_no_files() {
        let home = tree();
        let got = complete("~/projects/", &home);
        assert_eq!(got.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["plyfold", "tsumiki", "Pebrel"]);
        assert!(got[0].git && !got[2].git);
    }

    #[test]
    fn hides_dot_folders_unless_asked() {
        let home = tree();
        assert!(complete("~/", &home).iter().all(|c| !c.name.starts_with('.')));
        assert_eq!(complete("~/.c", &home)[0].name, ".config");
        assert!(complete("", &home).is_empty());
    }
}
