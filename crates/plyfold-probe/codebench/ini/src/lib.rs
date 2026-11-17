#[derive(Debug, PartialEq, Eq)]
pub struct ParseError {
    pub line: usize,
    pub kind: ErrorKind,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ErrorKind {
    MissingEquals,
    BadSection,
    EmptyKey,
    UnterminatedQuote,
    BadEscape,
    TrailingGarbage,
}

pub struct Ini {
    // define as you like
}

impl Ini {
    pub fn get(&self, section: &str, key: &str) -> Option<&str> {
        let _ = (section, key);
        todo!("implement as specified in README.md")
    }

    pub fn sections(&self) -> Vec<&str> {
        todo!()
    }
}

pub fn parse(src: &str) -> Result<Ini, ParseError> {
    let _ = src;
    todo!()
}
