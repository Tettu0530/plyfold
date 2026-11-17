//! エンジンが画面に出す文（エラー、知らせ）の言語。画面の言語に合わせて、デスクトップのアプリが set_lang で切り替える
//!
//!   tr!("セッション {id} がありません", "Session {id} not found")
//!   #[error("{}", tr!("セッション {} がありません", "Session {} not found", .0))]   // thiserror の中でも使える
//!
//! 日本語と英語の文を並べて書く（呼ぶ場所のすぐそばに両方の言語がある）。言語を足すときは、引数を足す

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ja,
    En,
}

static LANG: AtomicU8 = AtomicU8::new(0);

/// "ja" / "en"（ほかは英語）
pub fn set_lang(code: &str) {
    let l = if code.starts_with("ja") { 0 } else { 1 };
    LANG.store(l, Ordering::Relaxed);
}

pub fn lang() -> Lang {
    if LANG.load(Ordering::Relaxed) == 0 { Lang::Ja } else { Lang::En }
}

pub fn is_en() -> bool {
    lang() == Lang::En
}

/// 今の言語の文を format! で作る。`tr!(ja, en, 引数…)`
#[macro_export]
macro_rules! tr {
    ($ja:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        if $crate::is_en() { format!($en $(, $arg)*) } else { format!($ja $(, $arg)*) }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_language_and_captures_names() {
        let n = 3;
        set_lang("ja");
        assert_eq!(tr!("{n} 件", "{n} items"), "3 件");
        set_lang("en");
        assert_eq!(tr!("{n} 件", "{n} items"), "3 items");
        assert_eq!(tr!("{} と {}", "{} and {}", 1, 2), "1 and 2");
        set_lang("ja");
    }
}
