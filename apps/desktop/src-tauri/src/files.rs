//! File search for @-mentions in the composer: lists the files under a session's working directory and
//! ranks them against what the user typed after `@`.
//!
//! - In a git repository the list comes from `git ls-files` (tracked plus untracked, minus ignored files),
//!   so build output and dependencies stay out. Elsewhere it walks the directory, skipping hidden entries
//!   and common dependency/build folders, up to a file limit
//! - Lists are cached per directory for a few seconds, so typing doesn't re-run git on every keystroke
//! - Matching is a fuzzy subsequence match; matches in the file name, at word starts and consecutive runs score higher

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

const CACHE_FOR: Duration = Duration::from_secs(5);
const WALK_LIMIT: usize = 20_000;
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".git", ".next", "vendor", "__pycache__"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileHit {
    /// Path relative to the root, with `/` separators
    pub path: String,
    /// Absolute path (what gets attached)
    pub abs: String,
}

#[derive(Default)]
pub struct FileIndex {
    cache: Mutex<HashMap<PathBuf, (Instant, std::sync::Arc<Vec<String>>)>>,
}

impl FileIndex {
    /// Up to `limit` files under `root` matching `query`, best first. An empty query lists files in path order
    pub fn search(&self, root: &Path, query: &str, limit: usize) -> Vec<FileHit> {
        let files = self.files(root);
        let q = query.trim().to_lowercase();
        let mut scored: Vec<(i64, &String)> = files.iter().filter_map(|p| score(p, &q).map(|s| (s, p))).collect();
        // Higher score first; ties go to shorter paths, then alphabetical
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.len().cmp(&b.1.len())).then(a.1.cmp(b.1)));
        scored
            .into_iter()
            .take(limit)
            .map(|(_, p)| FileHit { path: p.clone(), abs: root.join(p).to_string_lossy().into_owned() })
            .collect()
    }

    fn files(&self, root: &Path) -> std::sync::Arc<Vec<String>> {
        let mut cache = self.cache.lock().unwrap();
        if let Some((at, list)) = cache.get(root)
            && at.elapsed() < CACHE_FOR
        {
            return list.clone();
        }
        let list = std::sync::Arc::new(git_files(root).unwrap_or_else(|| walk(root)));
        cache.insert(root.to_path_buf(), (Instant::now(), list.clone()));
        list
    }
}

fn git_files(root: &Path) -> Option<Vec<String>> {
    let out = std::process::Command::new("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut files: Vec<String> = out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
    files.sort();
    files.dedup();
    Some(files)
}

fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for e in read.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= WALK_LIMIT {
                    out.sort();
                    return out;
                }
            }
        }
    }
    out.sort();
    out
}

/// Fuzzy score of `path` against the lowercase query, or None if the query is not a subsequence of the path
pub fn score(path: &str, q: &str) -> Option<i64> {
    if q.is_empty() {
        return Some(0);
    }
    let lower = path.to_lowercase();
    let name_start = lower.rfind('/').map_or(0, |i| i + 1);
    let name = &lower[name_start..];
    let mut s: i64 = 0;
    // Strong bonuses for the file name itself
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    if name == q {
        s += 1000;
    } else if stem == q {
        s += 900;
    } else if name.starts_with(q) {
        s += 600;
    } else if name.contains(q) {
        s += 400;
    } else if lower.contains(q) {
        s += 200;
    }
    // Subsequence match over the whole path
    let chars: Vec<char> = lower.chars().collect();
    let mut i = 0;
    let mut prev: Option<usize> = None;
    for qc in q.chars() {
        let mut found = None;
        while i < chars.len() {
            if chars[i] == qc {
                found = Some(i);
                break;
            }
            i += 1;
        }
        let at = found?;
        // Consecutive characters and characters at word starts count more
        if prev.is_some_and(|p| p + 1 == at) {
            s += 15;
        }
        if at == 0 || matches!(chars[at - 1], '/' | '_' | '-' | '.' | ' ') {
            s += 10;
        }
        prev = Some(at);
        i = at + 1;
    }
    // Prefer shallow paths a little
    s -= lower.matches('/').count() as i64 * 2;
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_file_name_matches_first() {
        let q = "lib";
        let mut paths = vec!["docs/library-notes.md", "src/lib.rs", "crates/x/src/lib.rs", "apps/a/bundle/l_i_b.txt"];
        paths.sort_by_key(|p| std::cmp::Reverse(score(p, q).unwrap_or(i64::MIN)));
        assert_eq!(paths[0], "src/lib.rs");
        assert_eq!(paths[1], "crates/x/src/lib.rs");
        assert!(score("src/main.rs", "lib").is_none());
    }

    #[test]
    fn matches_subsequences_across_folders() {
        assert!(score("apps/desktop/src/components/pane/Composer.tsx", "pcomp").is_some());
        assert!(score("apps/desktop/src/components/pane/Composer.tsx", "xyz").is_none());
        // Word starts beat scattered letters
        assert!(score("src/file_index.rs", "fi").unwrap() > score("src/conflict.rs", "fi").unwrap());
    }

    #[test]
    fn lists_this_repository_through_git() {
        // The crate lives inside the Plyfold repository, so git ls-files works here (also in CI)
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let hits = FileIndex::default().search(&root, "composer", 5);
        // Exact name matches come first (the i18n composer.ts dictionaries tie with Composer.tsx)
        assert!(hits.iter().any(|h| h.path == "apps/desktop/src/components/pane/Composer.tsx"), "{hits:?}");
        assert!(hits.iter().take(4).all(|h| h.path.to_lowercase().contains("composer")), "{hits:?}");
        // Ignored build output never shows up
        assert!(FileIndex::default().search(&root, "target/debug", 50).iter().all(|h| !h.path.starts_with("target/")));
    }

    #[test]
    fn walks_plain_folders_without_hidden_or_dependency_dirs() {
        let d = std::env::temp_dir().join(format!("plyfold-files-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        for p in ["src/main.rs", "node_modules/x/index.js", ".hidden/a.txt", "README.md"] {
            let f = d.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
        assert_eq!(walk(&d), vec!["README.md".to_string(), "src/main.rs".to_string()]);
        let hits = FileIndex::default().search(&d, "main", 10);
        assert_eq!(hits[0].path, "src/main.rs");
        assert!(hits[0].abs.ends_with("/src/main.rs"));
    }
}
