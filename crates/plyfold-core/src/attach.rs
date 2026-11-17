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
    // Percent-encode characters not allowed in URIs so paths with spaces or non-ASCII text work
    let mut out = String::from("file://");
    for b in path.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
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
                let image_mime = mime_of(&path).filter(|m| m.starts_with("image/"));
                let small = std::fs::metadata(&path).map(|m| m.len() <= MAX_IMAGE_BYTES).unwrap_or(false);
                match (images && small, image_mime) {
                    (true, Some(mime)) => {
                        let bytes = std::fs::read(&path)?;
                        blocks.push(ContentBlock::Image(ImageContent::new(B64.encode(bytes), mime).uri(file_uri(&path))));
                    }
                    _ => blocks.push(link(&path)),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("plyfold-attach-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
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
        let blocks = prompt_blocks("", &[Attachment::Image { data: B64.encode(b"png"), mime: "image/png".into(), name: Some("スクショ.png".into()) }], false, &d).unwrap();
        assert_eq!(blocks.len(), 1);
        let ContentBlock::ResourceLink(l) = &blocks[0] else { panic!("link expected") };
        assert!(l.uri.starts_with("file://"));
        let path = std::fs::read_dir(&d).unwrap().next().unwrap().unwrap().path();
        assert_eq!(std::fs::read(path).unwrap(), b"png");
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
        std::fs::write(&f, b"img").unwrap();
        let blocks = prompt_blocks("", &[Attachment::File { path: f.to_string_lossy().into() }], true, &d).unwrap();
        let ContentBlock::Image(i) = &blocks[0] else { panic!("image expected") };
        assert_eq!(i.data, B64.encode(b"img"));
        assert!(i.uri.as_deref().unwrap().starts_with("file://"));
    }
}
