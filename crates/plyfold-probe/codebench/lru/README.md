# lru

LRU キャッシュ `LruCache` を `src/lib.rs` に実装してください。

```rust
pub struct LruCache<K, V> { /* 自由 */ }

impl<K: std::hash::Hash + Eq + Clone, V> LruCache<K, V> {
    pub fn new(capacity: usize) -> Self;
    pub fn get(&mut self, key: &K) -> Option<&V>;     // 見つかったら「最近使った」扱いにする
    pub fn peek(&self, key: &K) -> Option<&V>;        // 順序を変えない
    pub fn put(&mut self, key: K, value: V) -> Option<V>;
    pub fn remove(&mut self, key: &K) -> Option<V>;
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;
}
```

## 仕様

- `put`
  - キーがすでにあれば、値を置き換えて古い値を返し、そのキーを「最近使った」扱いにする（件数は変わらない）
  - キーがなければ追加して `None` を返す。容量を超える場合は、一番使われていないものを先に追い出す
- `capacity` が 0 のときは何も保持しない（`put` は常に `None` を返し、`len` は 0）
- `get`、`put`、`remove` は平均 O(1) にすること（大きな容量で大量の操作をするテストがある）
- 外部クレートは使わない
