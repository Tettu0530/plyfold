//! エンジンが画面に出す文（エラー、知らせ）の言語。画面の言語に合わせて、デスクトップのアプリが set_lang で切り替える
//!
//!   tr!("セッション {id} がありません", "Session {id} not found", "会话 {id} 不存在")
//!   #[error("{}", tr!("セッション {} がありません", "Session {} not found", "会话 {} 不存在", .0))]   // thiserror の中でも使える
//!
//! 日本語・英語・中国語（簡体）の文を並べて書く（呼ぶ場所のすぐそばにすべての言語がある）。言語を足すときは、引数を足す

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ja,
    En,
    Zh,
}

static LANG: AtomicU8 = AtomicU8::new(0);

/// "ja" / "en" / "zh"（ほかは英語）
pub fn set_lang(code: &str) {
    let l = if code.starts_with("ja") {
        0
    } else if code.starts_with("zh") {
        2
    } else {
        1
    };
    LANG.store(l, Ordering::Relaxed);
}

pub fn lang() -> Lang {
    match LANG.load(Ordering::Relaxed) {
        0 => Lang::Ja,
        2 => Lang::Zh,
        _ => Lang::En,
    }
}

pub fn is_en() -> bool {
    lang() == Lang::En
}

/// 今の言語の文を format! で作る。`tr!(ja, en, zh, 引数…)`（3 つの言語の文はどれも省けない）
#[macro_export]
macro_rules! tr {
    ($ja:literal, $en:literal, $zh:literal $(, $arg:expr)* $(,)?) => {
        match $crate::lang() {
            $crate::Lang::Ja => format!($ja $(, $arg)*),
            $crate::Lang::En => format!($en $(, $arg)*),
            $crate::Lang::Zh => format!($zh $(, $arg)*),
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_language_and_captures_names() {
        let n = 3;
        set_lang("ja");
        assert_eq!(tr!("{n} 件", "{n} items", "{n} 项"), "3 件");
        set_lang("en");
        assert_eq!(tr!("{n} 件", "{n} items", "{n} 项"), "3 items");
        assert_eq!(tr!("{} と {}", "{} and {}", "{} 和 {}", 1, 2), "1 and 2");
        set_lang("zh-CN");
        assert_eq!(tr!("{n} 件", "{n} items", "{n} 项"), "3 项");
        set_lang("ja");
    }
}
