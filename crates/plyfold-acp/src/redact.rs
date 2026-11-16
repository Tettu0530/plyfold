/// ログに残す前に、キーなどの秘密の値を伏せ字にする
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    pub fn new(secrets: Vec<String>) -> Self {
        // 短すぎる値は誤爆が多いので対象にしない
        let mut secrets: Vec<String> = secrets.into_iter().filter(|s| s.len() >= 8).collect();
        // 長いものから置き換える（一方が他方を含む場合に備える）
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Self { secrets }
    }

    pub fn redact(&self, s: &str) -> String {
        let mut out = s.to_string();
        for secret in &self.secrets {
            if out.contains(secret.as_str()) {
                out = out.replace(secret.as_str(), "***");
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_longest_first_and_skips_short() {
        let r = Redactor::new(vec!["sk-abcdef".into(), "sk-abcdef-0123456789".into(), "abc".into()]);
        assert_eq!(r.redact("key=sk-abcdef-0123456789 other=sk-abcdef abc"), "key=*** other=*** abc");
    }
}
