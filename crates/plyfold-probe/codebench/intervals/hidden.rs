use intervals::{merge, subtract, total_len};

#[test]
fn h_touching_and_reversed() {
    assert_eq!(merge(&[(4, 6), (1, 3)]), vec![(1, 6)]);
    assert_eq!(merge(&[(5, 1), (7, 9)]), vec![(1, 5), (7, 9)]);
    assert_eq!(merge(&[(3, 3), (3, 3), (4, 4)]), vec![(3, 4)]);
    assert_eq!(merge(&[]), vec![]);
}

#[test]
fn h_total() {
    assert_eq!(total_len(&[(1, 3), (2, 5), (10, 10)]), 6);
    assert_eq!(total_len(&[(i64::MIN, i64::MAX)]), 1u128 << 64);
    assert_eq!(total_len(&[(-5, -1), (0, 4)]), 10);
}

#[test]
fn h_extremes() {
    assert_eq!(merge(&[(i64::MAX, i64::MAX), (i64::MIN, i64::MAX - 1)]), vec![(i64::MIN, i64::MAX)]);
    assert_eq!(subtract(&[(i64::MIN, i64::MAX)], &[(0, i64::MAX)]), vec![(i64::MIN, -1)]);
    assert_eq!(subtract(&[(i64::MIN, i64::MAX)], &[(i64::MIN, -1)]), vec![(0, i64::MAX)]);
}

#[test]
fn h_subtract_cases() {
    assert_eq!(subtract(&[(1, 10)], &[(1, 10)]), vec![]);
    assert_eq!(subtract(&[(1, 10)], &[(0, 3), (5, 5), (9, 20)]), vec![(4, 4), (6, 8)]);
    assert_eq!(subtract(&[(1, 5), (10, 15)], &[(3, 12)]), vec![(1, 2), (13, 15)]);
    assert_eq!(subtract(&[(1, 5)], &[]), vec![(1, 5)]);
    assert_eq!(subtract(&[(10, 1)], &[(5, 5)]), vec![(1, 4), (6, 10)]);
}
