use lru::LruCache;

#[test]
fn basic() {
    let mut c = LruCache::new(2);
    assert_eq!(c.put(1, "a"), None);
    assert_eq!(c.put(2, "b"), None);
    assert_eq!(c.get(&1), Some(&"a"));
    c.put(3, "c"); // 2 is evicted
    assert_eq!(c.get(&2), None);
    assert_eq!(c.len(), 2);
}
