# lru

Implement an LRU cache, `LruCache`, in `src/lib.rs`.

```rust
pub struct LruCache<K, V> { /* up to you */ }

impl<K: std::hash::Hash + Eq + Clone, V> LruCache<K, V> {
    pub fn new(capacity: usize) -> Self;
    pub fn get(&mut self, key: &K) -> Option<&V>;     // if found, mark it as most recently used
    pub fn peek(&self, key: &K) -> Option<&V>;        // does not change the order
    pub fn put(&mut self, key: K, value: V) -> Option<V>;
    pub fn remove(&mut self, key: &K) -> Option<V>;
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;
}
```

## Spec

- `put`
  - If the key already exists, replace the value, return the old value, and mark the key as most recently used (the count does not change)
  - If the key does not exist, insert it and return `None`. If this would exceed the capacity, evict the least recently used entry first
- With a `capacity` of 0, nothing is stored (`put` always returns `None` and `len` is 0)
- `get`, `put` and `remove` must be O(1) on average (a test performs many operations with a large capacity)
- Do not use external crates
