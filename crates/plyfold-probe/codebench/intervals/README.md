# intervals

`src/lib.rs` contains functions that work with closed intervals `[start, end]` (integer intervals including both ends).
There are a few bugs and `cargo test` fails. Fix them so the functions behave as specified.

## Spec

- An interval is `(i64, i64)`. An interval with `start > end` is treated as if its ends were swapped
- `merge(v)`: merges overlapping intervals and adjacent intervals (no gap between them, like `[1,3]` and `[4,6]`), returned in ascending order of `start`
- `total_len(v)`: the number of integers covered by the intervals (overlaps counted once). `[1,3]` covers 3
- `subtract(a, b)`: the part covered by `a` minus the part covered by `b`, returned in the same form as `merge`
- Values may span the full `i64` range (intervals containing `i64::MIN` or `i64::MAX` must not panic or overflow).
  `total_len` returns `u128`
- Do not change the function signatures
