use calc::{eval, CalcError};

#[test]
fn h_unary() {
    assert_eq!(eval("2--3"), Ok(5));
    assert_eq!(eval("-(2+3)"), Ok(-5));
    assert_eq!(eval("2*-3"), Ok(-6));
    assert_eq!(eval("--4"), Ok(4));
    assert_eq!(eval("- 7"), Ok(-7));
}

#[test]
fn h_assoc_and_rounding() {
    assert_eq!(eval("100 - 10 - 1"), Ok(89));
    assert_eq!(eval("100 / 10 / 2"), Ok(5));
    assert_eq!(eval("-7 / 2"), Ok(-3));
    assert_eq!(eval("7 % -3"), Ok(1));
    assert_eq!(eval("-7 % 3"), Ok(-1));
    assert_eq!(eval("2*(3+4)*5"), Ok(70));
    assert_eq!(eval("  ((((42))))  "), Ok(42));
}

#[test]
fn h_overflow() {
    assert_eq!(eval("9223372036854775807 + 1"), Err(CalcError::Overflow));
    assert_eq!(eval("9223372036854775808"), Err(CalcError::Overflow));
    assert_eq!(eval("-9223372036854775808"), Err(CalcError::Overflow));
    assert_eq!(eval("(-9223372036854775807 - 1) / -1"), Err(CalcError::Overflow));
    assert_eq!(eval("3037000500 * 3037000500"), Err(CalcError::Overflow));
    assert_eq!(eval("-9223372036854775807 - 1"), Ok(i64::MIN));
}

#[test]
fn h_parse_errors() {
    for bad in ["", "   ", "1 2", "1 +", "* 2", "(", ")", "()", "1 + (2", "1 + 2)", "1 $ 2", "1..2", "abc"] {
        assert_eq!(eval(bad), Err(CalcError::Parse), "input: {bad:?}");
    }
}

#[test]
fn h_div_zero() {
    assert_eq!(eval("5 % 0"), Err(CalcError::DivisionByZero));
    assert_eq!(eval("1 / (2 - 2)"), Err(CalcError::DivisionByZero));
}
