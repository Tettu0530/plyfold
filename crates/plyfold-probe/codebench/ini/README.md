# ini

Implement a parser for the INI format in `src/lib.rs`.

```rust
pub fn parse(src: &str) -> Result<Ini, ParseError>;

impl Ini {
    pub fn get(&self, section: &str, key: &str) -> Option<&str>;
    pub fn sections(&self) -> Vec<&str>;
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParseError { pub line: usize, pub kind: ErrorKind }

#[derive(Debug, PartialEq, Eq)]
pub enum ErrorKind { MissingEquals, BadSection, EmptyKey, UnterminatedQuote, BadEscape, TrailingGarbage }
```

## Spec

- Lines are separated by `\n` (`\r\n` is accepted too; a trailing `\r` is removed). Line numbers start at 1
- Lines that are empty after trimming surrounding whitespace are ignored. Lines starting with `;` or `#` are comments and are ignored
- `[name]`: starts a section. Surrounding whitespace is trimmed from `name`
  - No closing `]`, an empty `name`, or anything other than whitespace after `]` → `BadSection`
- `key = value`: split at the first `=`. Surrounding whitespace is trimmed from both key and value
  - No `=` → `MissingEquals`. Empty key → `EmptyKey`
  - Keys before the first section go into a section named `""`
  - If the same key appears twice in the same section, the later one wins
- A value starting with `"` is read as a quoted value
  - The only allowed escapes are `\"` `\\` `\n` `\t`. Any other `\x` → `BadEscape`
  - No closing `"` → `UnterminatedQuote`. Anything other than whitespace after the closing `"` → `TrailingGarbage`
  - Whitespace inside the quotes is kept as is
- Inline comments are not supported (the value of `a = b ; c` is `b ; c`)
- `sections()` returns section names in order of first appearance. The `""` section is included first only if it has at least one key.
  If a section with the same name appears twice, merge them into one (keys are combined)
- Names and keys are case-sensitive
- Do not use external crates
