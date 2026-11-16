#[derive(Debug, PartialEq, Eq)]
pub enum CalcError { DivisionByZero, Overflow, Parse }

struct P<'a> { s: &'a [u8], i: usize }

impl<'a> P<'a> {
    fn ws(&mut self) { while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() { self.i += 1; } }
    fn peek(&mut self) -> Option<u8> { self.ws(); self.s.get(self.i).copied() }
    fn expr(&mut self) -> Result<i64, CalcError> {
        let mut v = self.term()?;
        while let Some(c @ (b'+' | b'-')) = self.peek() {
            self.i += 1;
            let r = self.term()?;
            v = if c == b'+' { v.checked_add(r) } else { v.checked_sub(r) }.ok_or(CalcError::Overflow)?;
        }
        Ok(v)
    }
    fn term(&mut self) -> Result<i64, CalcError> {
        let mut v = self.unary()?;
        while let Some(c @ (b'*' | b'/' | b'%')) = self.peek() {
            self.i += 1;
            let r = self.unary()?;
            v = match c {
                b'*' => v.checked_mul(r).ok_or(CalcError::Overflow)?,
                _ => {
                    if r == 0 { return Err(CalcError::DivisionByZero); }
                    if c == b'/' { v.checked_div(r) } else { v.checked_rem(r) }.ok_or(CalcError::Overflow)?
                }
            };
        }
        Ok(v)
    }
    fn unary(&mut self) -> Result<i64, CalcError> {
        if self.peek() == Some(b'-') {
            self.i += 1;
            return self.unary()?.checked_neg().ok_or(CalcError::Overflow);
        }
        self.atom()
    }
    fn atom(&mut self) -> Result<i64, CalcError> {
        match self.peek() {
            Some(b'(') => {
                self.i += 1;
                let v = self.expr()?;
                if self.peek() != Some(b')') { return Err(CalcError::Parse); }
                self.i += 1;
                Ok(v)
            }
            Some(c) if c.is_ascii_digit() => {
                let st = self.i;
                while self.i < self.s.len() && self.s[self.i].is_ascii_digit() { self.i += 1; }
                std::str::from_utf8(&self.s[st..self.i]).unwrap().parse::<i64>().map_err(|_| CalcError::Overflow)
            }
            _ => Err(CalcError::Parse),
        }
    }
}

pub fn eval(expr: &str) -> Result<i64, CalcError> {
    let mut p = P { s: expr.as_bytes(), i: 0 };
    let v = p.expr()?;
    if p.peek().is_some() { return Err(CalcError::Parse); }
    Ok(v)
}
