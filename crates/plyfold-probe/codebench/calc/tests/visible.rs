use calc::{eval, CalcError};

#[test]
fn basic() {
    assert_eq!(eval("1 + 2 * 3"), Ok(7));
    assert_eq!(eval("(1 + 2) * 3"), Ok(9));
    assert_eq!(eval("10 / 3"), Ok(3));
    assert_eq!(eval("-2*3"), Ok(-6));
}

#[test]
fn errors() {
    assert_eq!(eval("1 / 0"), Err(CalcError::DivisionByZero));
    assert_eq!(eval("(1 + 2"), Err(CalcError::Parse));
}
