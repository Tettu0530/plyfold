# ini

INI 形式のパーサーを `src/lib.rs` に実装してください。

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

## 仕様

- 行は `\n` 区切り（`\r\n` も受け付け、行末の `\r` は取り除く）。行番号は 1 から数える
- 前後の空白を取り除いて、空になる行は無視する。`;` か `#` で始まる行はコメントとして無視する
- `[name]`：セクションの開始。`name` は前後の空白を取り除く
  - 閉じる `]` がない、`name` が空、`]` の後に空白以外がある → `BadSection`
- `key = value`：最初の `=` で分ける。キーと値はそれぞれ前後の空白を取り除く
  - `=` がない → `MissingEquals`。キーが空 → `EmptyKey`
  - 最初のセクションより前のキーは、名前が `""` のセクションに入る
  - 同じセクションで同じキーが 2 回出たら、後のものが勝つ
- 値が `"` で始まるときは、引用符付きの値として読む
  - 使えるエスケープは `\"` `\\` `\n` `\t` だけ。それ以外の `\x` → `BadEscape`
  - 閉じる `"` がない → `UnterminatedQuote`。閉じる `"` の後に空白以外がある → `TrailingGarbage`
  - 引用符の中の空白はそのまま残す
- 値の途中のコメントには対応しない（`a = b ; c` の値は `b ; c`）
- `sections()` は、セクションが最初に現れた順に名前を返す。`""` のセクションは、キーが 1 つ以上あるときだけ先頭に含める。
  同じ名前のセクションが 2 回出たら、1 つにまとめる（キーは合算する）
- 名前とキーは大文字と小文字を区別する
- 外部クレートは使わない
