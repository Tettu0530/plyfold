pub type Interval = (i64, i64);

fn norm(iv: Interval) -> Interval { if iv.0 <= iv.1 { iv } else { (iv.1, iv.0) } }

pub fn merge(v: &[Interval]) -> Vec<Interval> {
    let mut v: Vec<Interval> = v.iter().copied().map(norm).collect();
    v.sort();
    let mut out: Vec<Interval> = Vec::new();
    for (s, e) in v {
        if let Some(last) = out.last_mut() {
            if (s as i128) <= (last.1 as i128) + 1 {
                if e > last.1 { last.1 = e; }
                continue;
            }
        }
        out.push((s, e));
    }
    out
}

pub fn total_len(v: &[Interval]) -> u128 {
    merge(v).iter().map(|&(s, e)| (e as i128 - s as i128 + 1) as u128).sum()
}

pub fn subtract(a: &[Interval], b: &[Interval]) -> Vec<Interval> {
    let b = merge(b);
    let mut out = Vec::new();
    for (s, e) in merge(a) {
        let mut cur = s as i128;
        let e = e as i128;
        for &(bs, be) in &b {
            let (bs, be) = (bs as i128, be as i128);
            if be < cur || bs > e { continue; }
            if bs > cur { out.push((cur as i64, (bs - 1) as i64)); }
            cur = be + 1;
            if cur > e { break; }
        }
        if cur <= e { out.push((cur as i64, e as i64)); }
    }
    out
}
