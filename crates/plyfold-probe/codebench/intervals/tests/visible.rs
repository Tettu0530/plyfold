use intervals::{merge, subtract, total_len};

#[test]
fn merge_basic() {
    assert_eq!(merge(&[(1, 3), (2, 6), (8, 10)]), vec![(1, 6), (8, 10)]);
    assert_eq!(merge(&[(1, 10), (2, 3)]), vec![(1, 10)]);
}

#[test]
fn total_basic() {
    assert_eq!(total_len(&[(1, 3)]), 3);
}

#[test]
fn subtract_basic() {
    assert_eq!(subtract(&[(1, 10)], &[(4, 6)]), vec![(1, 3), (7, 10)]);
}
