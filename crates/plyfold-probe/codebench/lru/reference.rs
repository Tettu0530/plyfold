use std::collections::HashMap;
use std::hash::Hash;

struct Node<K, V> { key: K, val: V, prev: usize, next: usize }
const NIL: usize = usize::MAX;

pub struct LruCache<K, V> {
    cap: usize, map: HashMap<K, usize>, nodes: Vec<Option<Node<K, V>>>, free: Vec<usize>, head: usize, tail: usize,
}

impl<K: Hash + Eq + Clone, V> LruCache<K, V> {
    pub fn new(capacity: usize) -> Self {
        Self { cap: capacity, map: HashMap::new(), nodes: Vec::new(), free: Vec::new(), head: NIL, tail: NIL }
    }
    fn unlink(&mut self, i: usize) {
        let (p, n) = { let nd = self.nodes[i].as_ref().unwrap(); (nd.prev, nd.next) };
        if p != NIL { self.nodes[p].as_mut().unwrap().next = n; } else { self.head = n; }
        if n != NIL { self.nodes[n].as_mut().unwrap().prev = p; } else { self.tail = p; }
    }
    fn push_front(&mut self, i: usize) {
        let h = self.head;
        { let nd = self.nodes[i].as_mut().unwrap(); nd.prev = NIL; nd.next = h; }
        if h != NIL { self.nodes[h].as_mut().unwrap().prev = i; } else { self.tail = i; }
        self.head = i;
    }
    pub fn get(&mut self, key: &K) -> Option<&V> {
        let i = *self.map.get(key)?;
        self.unlink(i); self.push_front(i);
        Some(&self.nodes[i].as_ref().unwrap().val)
    }
    pub fn peek(&self, key: &K) -> Option<&V> {
        self.map.get(key).map(|&i| &self.nodes[i].as_ref().unwrap().val)
    }
    pub fn put(&mut self, key: K, value: V) -> Option<V> {
        if self.cap == 0 { return None; }
        if let Some(&i) = self.map.get(&key) {
            let old = std::mem::replace(&mut self.nodes[i].as_mut().unwrap().val, value);
            self.unlink(i); self.push_front(i);
            return Some(old);
        }
        if self.map.len() == self.cap {
            let t = self.tail;
            self.unlink(t);
            let nd = self.nodes[t].take().unwrap();
            self.map.remove(&nd.key);
            self.free.push(t);
        }
        let node = Node { key: key.clone(), val: value, prev: NIL, next: NIL };
        let i = if let Some(i) = self.free.pop() { self.nodes[i] = Some(node); i } else { self.nodes.push(Some(node)); self.nodes.len() - 1 };
        self.map.insert(key, i);
        self.push_front(i);
        None
    }
    pub fn remove(&mut self, key: &K) -> Option<V> {
        let i = self.map.remove(key)?;
        self.unlink(i);
        let nd = self.nodes[i].take().unwrap();
        self.free.push(i);
        Some(nd.val)
    }
    pub fn len(&self) -> usize { self.map.len() }
    pub fn is_empty(&self) -> bool { self.map.is_empty() }
}
