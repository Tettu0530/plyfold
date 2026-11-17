# calc

Implement `eval`, a function that evaluates integer arithmetic expressions, in `src/lib.rs`.

```rust
pub fn eval(expr: &str) -> Result<i64, CalcError>;

#[derive(Debug, PartialEq, Eq)]
pub enum CalcError { DivisionByZero, Overflow, Parse }
```

## Spec

- Allowed: decimal integer literals, `+ - * / %`, parentheses `( )`, unary minus, whitespace (ignored)
- Precedence: unary minus > `* / %` > `+ -`. Binary operators are left-associative
  - Examples: `-2*3` = -6, `2--3` = 5, `-(2+3)` = -5, `2*-3` = -6
- Compute in `i64`. `/` and `%` behave like Rust's `i64` (truncation toward zero; `7 % -3` = 1)
- Errors
  - Division by zero (both `/` and `%`) → `DivisionByZero`
  - An intermediate or final value does not fit in `i64` → `Overflow`
  - An integer literal itself does not fit in `i64` → `Overflow` (`-9223372036854775808` is also `Overflow`, since the literal `9223372036854775808` does not fit)
  - Any other invalid input (empty expression, mismatched parentheses, unknown characters, a missing operator as in `1 2`, etc.) → `Parse`
- Do not use external crates
