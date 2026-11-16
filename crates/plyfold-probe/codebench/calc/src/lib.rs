#[derive(Debug, PartialEq, Eq)]
pub enum CalcError {
    DivisionByZero,
    Overflow,
    Parse,
}

pub fn eval(expr: &str) -> Result<i64, CalcError> {
    let _ = expr;
    todo!("README.md の仕様どおりに実装する")
}
