use ini::{parse, ErrorKind};

#[test]
fn basic() {
    let ini = parse("[server]\nhost = example.com\nport=8080\n").unwrap();
    assert_eq!(ini.get("server", "host"), Some("example.com"));
    assert_eq!(ini.get("server", "port"), Some("8080"));
    assert_eq!(ini.sections(), vec!["server"]);
}

#[test]
fn missing_equals() {
    let e = parse("[a]\nfoo\n").err().unwrap();
    assert_eq!((e.line, e.kind), (2, ErrorKind::MissingEquals));
}
