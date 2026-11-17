pub struct LruCache<K, V> {
    _marker: std::marker::PhantomData<(K, V)>,
}

impl<K: std::hash::Hash + Eq + Clone, V> LruCache<K, V> {
    pub fn new(capacity: usize) -> Self {
        let _ = capacity;
        todo!("implement as specified in README.md")
    }
    pub fn get(&mut self, key: &K) -> Option<&V> {
        let _ = key;
        todo!()
    }
    pub fn peek(&self, key: &K) -> Option<&V> {
        let _ = key;
        todo!()
    }
    pub fn put(&mut self, key: K, value: V) -> Option<V> {
        let _ = (key, value);
        todo!()
    }
    pub fn remove(&mut self, key: &K) -> Option<V> {
        let _ = key;
        todo!()
    }
    pub fn len(&self) -> usize {
        todo!()
    }
    pub fn is_empty(&self) -> bool {
        todo!()
    }
}
