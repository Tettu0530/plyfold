//! Language of the text the engine shows in the UI (errors, notices). The desktop app switches it with set_lang to match the UI language
//!
//!   tr!("セッション {id} がありません", "Session {id} not found", "会话 {id} 不存在")
//!   #[error("{}", tr!("セッション {} がありません", "Session {} not found", "会话 {} 不存在", .0))]   // also works inside thiserror
//!
//! Japanese, English and Simplified Chinese text is written side by side, so every language sits right at the call site. To add a language, add an argument

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ja,
    En,
    Zh,
}

static LANG: AtomicU8 = AtomicU8::new(0);

/// "ja" / "en" / "zh" (anything else means English)
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

/// Formats the text for the current language with format!. `tr!(ja, en, zh, args...)` (none of the three texts may be omitted)
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
