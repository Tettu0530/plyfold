use ini::{parse, ErrorKind, ParseError};

fn err(src: &str) -> (usize, ErrorKind) {
    let ParseError { line, kind } = parse(src).err().expect("should be an error");
    (line, kind)
}

#[test]
fn h_comments_blank_crlf() {
    let ini = parse("; c\r\n# c\r\n\r\n  [ s ]  \r\n  k  =  v v  \r\n").unwrap();
    assert_eq!(ini.get("s", "k"), Some("v v"));
    assert_eq!(ini.sections(), vec!["s"]);
}

#[test]
fn h_global_and_order() {
    let ini = parse("g = 1\n[b]\nx=1\n[a]\ny=2\n[b]\nz=3\n").unwrap();
    assert_eq!(ini.sections(), vec!["", "b", "a"]);
    assert_eq!(ini.get("", "g"), Some("1"));
    assert_eq!(ini.get("b", "x"), Some("1"));
    assert_eq!(ini.get("b", "z"), Some("3"));
    let ini = parse("[only]\n").unwrap();
    assert_eq!(ini.sections(), vec!["only"]);
}

#[test]
fn h_duplicates_and_case() {
    let ini = parse("[s]\nk=1\nK=2\nk=3\n").unwrap();
    assert_eq!(ini.get("s", "k"), Some("3"));
    assert_eq!(ini.get("s", "K"), Some("2"));
    assert_eq!(ini.get("S", "k"), None);
    assert_eq!(ini.get("s", "missing"), None);
}

#[test]
fn h_values() {
    let ini = parse("[s]\na = b ; c\nempty =\neq = x=y=z\nq = \"  hi \\\"there\\\" \\\\ \\n\\t \"  \n").unwrap();
    assert_eq!(ini.get("s", "a"), Some("b ; c"));
    assert_eq!(ini.get("s", "empty"), Some(""));
    assert_eq!(ini.get("s", "eq"), Some("x=y=z"));
    assert_eq!(ini.get("s", "q"), Some("  hi \"there\" \\ \n\t "));
}

#[test]
fn h_errors() {
    assert_eq!(err("[s\n"), (1, ErrorKind::BadSection));
    assert_eq!(err("\n\n[  ]\n"), (3, ErrorKind::BadSection));
    assert_eq!(err("[s] x\n"), (1, ErrorKind::BadSection));
    assert_eq!(err("[s]\n = v\n"), (2, ErrorKind::EmptyKey));
    assert_eq!(err("[s]\nk = \"abc\n"), (2, ErrorKind::UnterminatedQuote));
    assert_eq!(err("[s]\nk = \"a\\qb\"\n"), (2, ErrorKind::BadEscape));
    assert_eq!(err("[s]\nk = \"a\" b\n"), (2, ErrorKind::TrailingGarbage));
    assert_eq!(err("[s]\nk = \"a\\\"\n"), (2, ErrorKind::UnterminatedQuote));
    assert_eq!(err("a=1\r\n\r\nbad line\r\n"), (3, ErrorKind::MissingEquals));
}

#[test]
fn h_unicode() {
    let ini = parse("[日本]\nキー = 値　\n").unwrap();
    // full-width spaces are trimmed as surrounding whitespace too (same as str::trim)
    assert_eq!(ini.get("日本", "キー"), Some("値"));
}
