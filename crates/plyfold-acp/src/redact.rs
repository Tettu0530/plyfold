/// Masks secret values such as keys before they reach the logs
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    pub fn new(secrets: Vec<String>) -> Self {
        // Skip values that are too short; they cause too many false matches
        let mut secrets: Vec<String> = secrets.into_iter().filter(|s| s.len() >= 8).collect();
        // Replace longest first, in case one secret contains another
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
