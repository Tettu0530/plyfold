use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub struct ParseError { pub line: usize, pub kind: ErrorKind }
#[derive(Debug, PartialEq, Eq)]
pub enum ErrorKind { MissingEquals, BadSection, EmptyKey, UnterminatedQuote, BadEscape, TrailingGarbage }

pub struct Ini { order: Vec<String>, data: HashMap<String, HashMap<String, String>> }

impl Ini {
    pub fn get(&self, section: &str, key: &str) -> Option<&str> {
        self.data.get(section)?.get(key).map(String::as_str)
    }
    pub fn sections(&self) -> Vec<&str> {
        self.order.iter().filter(|s| !s.is_empty() || self.data.get(s.as_str()).map_or(false, |m| !m.is_empty())).map(String::as_str).collect()
    }
}

fn quoted(v: &str) -> Result<String, ErrorKind> {
    let mut out = String::new();
    let mut it = v[1..].chars();
    loop {
        match it.next() {
            None => return Err(ErrorKind::UnterminatedQuote),
            Some('"') => break,
            Some('\\') => match it.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                None => return Err(ErrorKind::UnterminatedQuote),
                Some(_) => return Err(ErrorKind::BadEscape),
            },
            Some(c) => out.push(c),
        }
    }
    if !it.as_str().trim().is_empty() { return Err(ErrorKind::TrailingGarbage); }
    Ok(out)
}

pub fn parse(src: &str) -> Result<Ini, ParseError> {
    let mut ini = Ini { order: vec![String::new()], data: HashMap::new() };
    ini.data.insert(String::new(), HashMap::new());
    let mut cur = String::new();
    for (i, raw) in src.split('\n').enumerate() {
        let line_no = i + 1;
        let e = |kind| ParseError { line: line_no, kind };
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') { continue; }
        if let Some(rest) = line.strip_prefix('[') {
            let close = rest.find(']').ok_or(e(ErrorKind::BadSection))?;
            let name = rest[..close].trim();
            if name.is_empty() || !rest[close + 1..].trim().is_empty() { return Err(e(ErrorKind::BadSection)); }
            if !ini.data.contains_key(name) { ini.order.push(name.to_string()); ini.data.insert(name.to_string(), HashMap::new()); }
            cur = name.to_string();
            continue;
        }
        let eq = line.find('=').ok_or(e(ErrorKind::MissingEquals))?;
        let key = line[..eq].trim();
        if key.is_empty() { return Err(e(ErrorKind::EmptyKey)); }
        let v = line[eq + 1..].trim();
        let v = if v.starts_with('"') { quoted(v).map_err(e)? } else { v.to_string() };
        ini.data.get_mut(&cur).unwrap().insert(key.to_string(), v);
    }
    Ok(ini)
}
