//! Turns prompt attachments (images, files) into ACP content blocks
//!
//! - Images: an image block (base64) if the agent supports images. Otherwise they are
//!   written to attachments/ in the state dir and passed as a resource_link
//! - Files: a resource_link (file:// URI). Image files become image blocks if the agent supports images
//!
//! Every agent accepts resource_link (per the ACP spec). Only the path is passed; the contents are not read

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use plyfold_acp::schema::{ContentBlock, ImageContent, ResourceLink, TextContent};
use serde::Deserialize;

/// Size limit for inlining a file as an image block (larger images are passed as links)
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Attachment {
    /// A pasted image (base64)
    Image { data: String, mime: String, name: Option<String> },
    /// A dropped file
    File { path: String },
}

/// Guess the MIME type from the extension (None if unknown)
pub fn mime_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "md" => "text/markdown",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" => "text/html",
        _ => return None,
    })
}

fn ext_of(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn file_uri(path: &Path) -> String {
    uri_from_path(&path.to_string_lossy(), cfg!(windows))
}

/// file:///Users/me/a.md, or on Windows file:///C:/Users/me/a.md (backslashes become slashes, the drive stays as is).
/// Characters not allowed in URIs are percent-encoded so paths with spaces or non-ASCII text work
fn uri_from_path(path: &str, windows: bool) -> String {
    let path = if windows { path.replace('\\', "/") } else { path.to_string() };
    // A Windows path starts with a drive ("C:/…"); the URI path needs a leading slash before it
    let drive = windows && path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    let path = if drive { format!("/{path}") } else { path };
    let mut out = String::from("file://");
    for (i, b) in path.bytes().enumerate() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) || (drive && i == 2 && b == b':') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn link(path: &Path) -> ContentBlock {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned());
    let size = std::fs::metadata(path).ok().map(|m| m.len() as i64);
    ContentBlock::ResourceLink(ResourceLink::new(name, file_uri(path)).mime_type(mime_of(path).map(str::to_string)).size(size))
}

/// Build prompt blocks from text and attachments. `save_dir` is where images are written
pub fn prompt_blocks(text: &str, attachments: &[Attachment], images: bool, save_dir: &Path) -> std::io::Result<Vec<ContentBlock>> {
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text)));
    }
    for a in attachments {
        match a {
            Attachment::Image { data, mime, name } => {
                if images {
                    blocks.push(ContentBlock::Image(ImageContent::new(data.clone(), mime.clone())));
                } else {
                    let bytes = B64.decode(data).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                    let path = save_image(save_dir, name.as_deref(), mime, &bytes)?;
                    blocks.push(link(&path));
                }
            }
            Attachment::File { path } => {
                let path = PathBuf::from(path);
                let named_image = mime_of(&path).is_some_and(|m| m.starts_with("image/"));
                // Inlined only when its bytes are an image too; anything else goes as a link the agent may open
                let image = if images && named_image { read_image_file(&path, MAX_IMAGE_BYTES).ok().flatten() } else { None };
                match image {
                    Some((bytes, mime)) => {
                        blocks.push(ContentBlock::Image(ImageContent::new(B64.encode(bytes), mime.to_string()).uri(file_uri(&path))));
                    }
                    None => blocks.push(link(&path)),
                }
            }
        }
    }
    Ok(blocks)
}

fn save_image(dir: &Path, name: Option<&str>, mime: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    // Keep only safe characters in the name (pasted images often share names like image.png, so prefix a timestamp)
    let base: String = name
        .and_then(|n| Path::new(n).file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "image".into())
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let path = dir.join(format!("{stamp}-{base}.{}", ext_of(mime)));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// An image's type from its first bytes (PNG, JPEG, GIF, WebP), whatever its name says
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// Read an image file of at most `max` bytes: a regular file (not a pipe or a device, which a link named .png could
/// point at) whose bytes are an image. A secret behind a link named like an image is refused, not read out
pub fn read_image_file(path: &Path, max: u64) -> std::io::Result<Option<(Vec<u8>, &'static str)>> {
    use std::io::Read as _;
    if !std::fs::metadata(path)?.is_file() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Ok(None);
    }
    Ok(sniff_image(&bytes).map(|mime| (bytes, mime)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "plyfold-attach-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            {
                // The clock is only microsecond-precise on macOS, so tests running in parallel need a counter too
                static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            }
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn text_then_image_when_supported() {
        let d = tmp();
        let blocks = prompt_blocks("見て", &[Attachment::Image { data: B64.encode(b"png"), mime: "image/png".into(), name: None }], true, &d).unwrap();
        assert!(matches!(&blocks[0], ContentBlock::Text(t) if t.text == "見て"));
        assert!(matches!(&blocks[1], ContentBlock::Image(i) if i.mime_type == "image/png"));
    }

    #[test]
    fn image_becomes_a_saved_file_link_when_not_supported() {
        let d = tmp();
        let blocks =
            prompt_blocks("", &[Attachment::Image { data: B64.encode(b"png"), mime: "image/png".into(), name: Some("スクショ.png".into()) }], false, &d)
                .unwrap();
        assert_eq!(blocks.len(), 1);
        let ContentBlock::ResourceLink(l) = &blocks[0] else { panic!("link expected") };
        assert!(l.uri.starts_with("file://"));
        let path = std::fs::read_dir(&d).unwrap().next().unwrap().unwrap().path();
        assert_eq!(std::fs::read(path).unwrap(), b"png");
    }

    #[test]
    fn builds_file_uris_on_both_systems() {
        assert_eq!(uri_from_path("/Users/me/メモ a.md", false), "file:///Users/me/%E3%83%A1%E3%83%A2%20a.md");
        assert_eq!(uri_from_path(r"C:\Users\me\メモ a.md", true), "file:///C:/Users/me/%E3%83%A1%E3%83%A2%20a.md");
        // A UNC path has no drive
        assert_eq!(uri_from_path(r"\\server\share\a.md", true), "file:////server/share/a.md");
    }

    #[test]
    fn files_are_links_with_escaped_uris() {
        let d = tmp();
        let f = d.join("メモ a.md");
        std::fs::write(&f, "x").unwrap();
        let blocks = prompt_blocks("", &[Attachment::File { path: f.to_string_lossy().into() }], true, &d).unwrap();
        let ContentBlock::ResourceLink(l) = &blocks[0] else { panic!("link expected") };
        assert_eq!(l.name, "メモ a.md");
        assert!(l.uri.ends_with("/%E3%83%A1%E3%83%A2%20a.md"), "{}", l.uri);
        assert_eq!(l.mime_type.as_deref(), Some("text/markdown"));
        assert_eq!(l.size, Some(1));
    }

    #[test]
    fn image_files_are_sent_as_images_when_supported() {
        let d = tmp();
        let f = d.join("a.PNG");
        std::fs::write(&f, PNG).unwrap();
        let blocks = prompt_blocks("", &[Attachment::File { path: f.to_string_lossy().into() }], true, &d).unwrap();
        let ContentBlock::Image(i) = &blocks[0] else { panic!("image expected") };
        assert_eq!(i.data, B64.encode(PNG));
        assert_eq!(i.mime_type, "image/png");
        assert!(i.uri.as_deref().unwrap().starts_with("file://"));
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D];

    #[test]
    fn a_file_named_like_an_image_is_read_only_when_it_is_one() {
        let d = tmp();
        let secret = d.join("secret.txt");
        std::fs::write(&secret, "PLYFOLD-CANARY").unwrap();
        // Not an image inside: refused, and an attachment goes as a link instead of its bytes
        let fake = d.join("fake.png");
        std::fs::write(&fake, "PLYFOLD-CANARY").unwrap();
        assert!(read_image_file(&fake, 1 << 20).unwrap().is_none());
        let blocks = prompt_blocks("", &[Attachment::File { path: fake.to_string_lossy().into() }], true, &d).unwrap();
        assert!(matches!(&blocks[0], ContentBlock::ResourceLink(_)));
        #[cfg(unix)]
        {
            let link = d.join("link.png");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert!(read_image_file(&link, 1 << 20).unwrap().is_none());
            // A device or pipe behind the name is not read at all
            let dev = d.join("zero.png");
            let _ = std::fs::remove_file(&dev);
            std::os::unix::fs::symlink("/dev/zero", &dev).unwrap();
            assert!(read_image_file(&dev, 1 << 20).unwrap().is_none());
        }
        // An image over the limit is refused
        let big = d.join("big.png");
        std::fs::write(&big, [PNG, &[0u8; 64]].concat()).unwrap();
        assert!(read_image_file(&big, 32).unwrap().is_none());
        assert_eq!(read_image_file(&big, 1 << 20).unwrap().map(|(_, m)| m), Some("image/png"));
    }
}
