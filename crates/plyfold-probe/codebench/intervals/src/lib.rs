pub type Interval = (i64, i64);

pub fn merge(v: &[Interval]) -> Vec<Interval> {
    let mut v: Vec<Interval> = v.to_vec();
    v.sort();
    let mut out: Vec<Interval> = Vec::new();
    for (s, e) in v {
        if let Some(last) = out.last_mut() {
            if s < last.1 {
                last.1 = e;
                continue;
            }
        }
        out.push((s, e));
    }
    out
}

pub fn total_len(v: &[Interval]) -> u128 {
    merge(v).iter().map(|&(s, e)| (e - s) as u128).sum()
}

pub fn subtract(a: &[Interval], b: &[Interval]) -> Vec<Interval> {
    let b = merge(b);
    let mut out = Vec::new();
    for (s, e) in merge(a) {
        let mut cur = s;
        for &(bs, be) in &b {
            if be < cur || bs > e {
                continue;
            }
            if bs > cur {
                out.push((cur, bs));
            }
            cur = be + 1;
        }
        if cur <= e {
            out.push((cur, e));
        }
    }
    out
}
