use lru::LruCache;
use std::time::Instant;

#[test]
fn h_update_moves_to_front() {
    let mut c = LruCache::new(2);
    c.put("a", 1);
    c.put("b", 2);
    assert_eq!(c.put("a", 10), Some(1));
    assert_eq!(c.len(), 2);
    c.put("c", 3); // b が追い出される
    assert_eq!(c.peek(&"b"), None);
    assert_eq!(c.peek(&"a"), Some(&10));
    assert_eq!(c.peek(&"c"), Some(&3));
}

#[test]
fn h_peek_does_not_touch() {
    let mut c = LruCache::new(2);
    c.put(1, 1);
    c.put(2, 2);
    assert_eq!(c.peek(&1), Some(&1));
    c.put(3, 3); // peek しても 1 は古いまま
    assert_eq!(c.peek(&1), None);
    assert_eq!(c.peek(&2), Some(&2));
}

#[test]
fn h_remove_and_reuse() {
    let mut c = LruCache::new(3);
    for i in 0..3 { c.put(i, i * 10); }
    assert_eq!(c.remove(&1), Some(10));
    assert_eq!(c.remove(&1), None);
    assert_eq!(c.len(), 2);
    c.put(5, 50);
    c.put(6, 60); // 0 が追い出される
    assert_eq!(c.peek(&0), None);
    assert_eq!(c.peek(&2), Some(&20));
    assert_eq!(c.len(), 3);
    assert!(!c.is_empty());
}

#[test]
fn h_zero_capacity() {
    let mut c = LruCache::new(0);
    assert_eq!(c.put(1, 1), None);
    assert_eq!(c.put(1, 2), None);
    assert_eq!(c.get(&1), None);
    assert_eq!(c.len(), 0);
    assert!(c.is_empty());
}

#[test]
fn h_capacity_one() {
    let mut c = LruCache::new(1);
    c.put(1, 1);
    c.put(2, 2);
    assert_eq!(c.get(&1), None);
    assert_eq!(c.get(&2), Some(&2));
    assert_eq!(c.remove(&2), Some(2));
    assert!(c.is_empty());
    c.put(3, 3);
    assert_eq!(c.get(&3), Some(&3));
}

#[test]
fn h_against_model() {
    // 単純な実装と、疑似乱数の操作列で突き合わせる
    let mut c = LruCache::new(7);
    let mut model: Vec<(u32, u32)> = Vec::new(); // 先頭が最近
    let mut x: u64 = 12345;
    for step in 0..5000u32 {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        let k = (x % 15) as u32;
        match x % 3 {
            0 => {
                let got = c.get(&k).copied();
                let pos = model.iter().position(|e| e.0 == k);
                let want = pos.map(|p| { let e = model.remove(p); model.insert(0, e); e.1 });
                assert_eq!(got, want, "get step {step}");
            }
            1 => {
                let got = c.put(k, step);
                let pos = model.iter().position(|e| e.0 == k);
                let want = pos.map(|p| model.remove(p).1);
                model.insert(0, (k, step));
                model.truncate(7);
                assert_eq!(got, want, "put step {step}");
            }
            _ => {
                let got = c.remove(&k);
                let want = model.iter().position(|e| e.0 == k).map(|p| model.remove(p).1);
                assert_eq!(got, want, "remove step {step}");
            }
        }
        assert_eq!(c.len(), model.len());
    }
}

#[test]
fn h_performance() {
    let cap = 50_000;
    let mut c = LruCache::new(cap);
    let start = Instant::now();
    for i in 0..200_000u64 {
        c.put(i, i);
        if i % 3 == 0 { c.get(&(i / 2)); }
        if i % 5 == 0 && i > 0 { c.remove(&(i - 1)); }
    }
    assert!(c.len() <= cap);
    assert!(start.elapsed().as_secs_f64() < 5.0, "遅すぎる: {:?}", start.elapsed());
}
