//! The browser pane: a native child webview laid over the pane, so any site works (no framing limits) and sign-ins
//! persist. The page runs in its own webview with no access to the app: its origin is remote, so the app's commands
//! are refused by Tauri's ACL, and these commands also check that the main window is the caller.

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow};

use crate::{CmdResult, err};

/// WKWebView leaves "Safari/…" out of its User-Agent, and some sites (Google's search among them) take that for an old
/// browser and serve a stripped-down page. This is what Safari itself sends. (WebView2 and WebKitGTK already identify
/// themselves in full.)
#[cfg(target_os = "macos")]
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/// Where the page goes: logical pixels in the main window's coordinates
#[derive(Clone, Copy, Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }
    fn size(self) -> LogicalSize<f64> {
        LogicalSize::new(self.width.max(1.0), self.height.max(1.0))
    }
}

/// What a browser webview reports to the app (one event name, "browser")
#[derive(Clone, Serialize)]
struct BrowserEvent<'a> {
    label: &'a str,
    /// "navigated" (a page is being shown at `url`), "loading" / "loaded", "title", "new_window" (the page asked for another window)
    kind: &'static str,
    url: Option<String>,
    title: Option<String>,
}

fn report(app: &AppHandle, label: &str, kind: &'static str, url: Option<String>, title: Option<String>) {
    eprintln!("[browser-debug] {label} {kind} {url:?} {title:?}"); // TEMP-DEBUG
    let _ = app.emit_to("main", "browser", BrowserEvent { label, kind, url, title });
}

fn require_main(window: &WebviewWindow) -> CmdResult<()> {
    if window.label() != "main" {
        return Err("The browser can only be driven from the main window".into());
    }
    Ok(())
}

/// Only these labels are ours; the app's own webview ("main") can never be named here
fn checked_label(label: &str) -> CmdResult<()> {
    let ok = label
        .strip_prefix("browser-")
        .is_some_and(|rest| !rest.is_empty() && rest.len() <= 64 && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    if ok { Ok(()) } else { Err("Invalid browser label".into()) }
}

/// http and https only: never file:, the app's own scheme, javascript: and the like
fn web_url(url: &str) -> CmdResult<Url> {
    if url.chars().any(char::is_control) {
        return Err(plyfold_i18n::tr!("このリンクは開けません", "This link cannot be opened", "无法打开此链接"));
    }
    let parsed: Url = url.parse().map_err(|_| plyfold_i18n::tr!("このリンクは開けません", "This link cannot be opened", "无法打开此链接"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(plyfold_i18n::tr!("このリンクは開けません", "This link cannot be opened", "无法打开此链接"));
    }
    Ok(parsed)
}

fn find(app: &AppHandle, label: &str) -> CmdResult<tauri::Webview> {
    checked_label(label)?;
    let found = app.get_webview(label);
    eprintln!("[browser-debug] find {label} -> {}", found.is_some()); // TEMP-DEBUG
    found.ok_or_else(|| "The browser is not open".to_string())
}

/// Open the page in a child webview of the main window at the given rectangle (logical pixels, window coordinates).
/// If it is already open, only the rectangle is updated and the page shown
#[tauri::command]
pub async fn browser_open(app: AppHandle, window: WebviewWindow, label: String, url: String, rect: Rect) -> CmdResult<()> {
    eprintln!("[browser-debug] cmd browser_open {label}"); // TEMP-DEBUG
    require_main(&window)?;
    checked_label(&label)?;
    let target = web_url(&url)?;
    if let Some(existing) = app.get_webview(&label) {
        existing.set_position(rect.position()).map_err(err)?;
        existing.set_size(rect.size()).map_err(err)?;
        existing.show().map_err(err)?;
        return Ok(());
    }
    let main = app.get_window("main").ok_or_else(|| "No main window".to_string())?;
    let nav = app.clone();
    let nav_label = label.clone();
    let load = app.clone();
    let load_label = label.clone();
    let title = app.clone();
    let title_label = label.clone();
    let popup = app.clone();
    let popup_label = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target)).accept_first_mouse(true);
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(USER_AGENT);
    let builder = builder
        .on_navigation(move |url| {
            let ok = matches!(url.scheme(), "http" | "https" | "about");
            if ok && url.scheme() != "about" {
                report(&nav, &nav_label, "navigated", Some(url.to_string()), None);
            }
            ok
        })
        .on_page_load(move |_, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "loading",
                PageLoadEvent::Finished => "loaded",
            };
            report(&load, &load_label, kind, Some(payload.url().to_string()), None);
        })
        .on_document_title_changed(move |_, text| report(&title, &title_label, "title", None, Some(text)))
        // window.open and target=_blank: the app opens the address in the same pane
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "http" | "https") {
                report(&popup, &popup_label, "new_window", Some(url.to_string()), None);
            }
            NewWindowResponse::Deny
        });
    let created = main.add_child(builder, rect.position(), rect.size()).map_err(err);
    eprintln!("[browser-debug] open done {:?}", created.as_ref().map(|_| ())); // TEMP-DEBUG
    created?;
    Ok(())
}

/// Move and resize the page to the pane's rectangle
#[tauri::command]
pub fn browser_bounds(app: AppHandle, window: WebviewWindow, label: String, rect: Rect) -> CmdResult<()> {
    eprintln!("[browser-debug] cmd browser_bounds {label}"); // TEMP-DEBUG
    require_main(&window)?;
    let view = find(&app, &label)?;
    view.set_position(rect.position()).map_err(err)?;
    view.set_size(rect.size()).map_err(err)?;
    Ok(())
}

/// Hide the page while something of the app is drawn over it (a menu, a dialog), and show it again after
#[tauri::command]
pub fn browser_show(app: AppHandle, window: WebviewWindow, label: String, visible: bool) -> CmdResult<()> {
    eprintln!("[browser-debug] cmd browser_show {label}"); // TEMP-DEBUG
    require_main(&window)?;
    let view = find(&app, &label)?;
    if visible { view.show() } else { view.hide() }.map_err(err)
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, window: WebviewWindow, label: String, url: String) -> CmdResult<()> {
    eprintln!("[browser-debug] cmd browser_navigate {label}"); // TEMP-DEBUG
    require_main(&window)?;
    find(&app, &label)?.navigate(web_url(&url)?).map_err(err)
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, window: WebviewWindow, label: String) -> CmdResult<()> {
    eprintln!("[browser-debug] cmd browser_reload {label}"); // TEMP-DEBUG
    require_main(&window)?;
    find(&app, &label)?.reload().map_err(err)
}

/// Back (-1) or forward (1) in the page's history
#[tauri::command]
pub fn browser_history(app: AppHandle, window: WebviewWindow, label: String, delta: i32) -> CmdResult<()> {
    eprintln!("[browser-debug] cmd browser_history {label}"); // TEMP-DEBUG
    require_main(&window)?;
    let delta = delta.clamp(-1, 1);
    find(&app, &label)?.eval(format!("history.go({delta})")).map_err(err)
}

#[tauri::command]
pub fn browser_close(app: AppHandle, window: WebviewWindow, label: String) -> CmdResult<()> {
    eprintln!("[browser-debug] cmd browser_close {label}"); // TEMP-DEBUG
    require_main(&window)?;
    checked_label(&label)?;
    if let Some(view) = app.get_webview(&label) {
        view.close().map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_browser_labels_are_accepted() {
        assert!(checked_label("browser-preview-123").is_ok());
        assert!(checked_label("main").is_err());
        assert!(checked_label("browser-").is_err());
        assert!(checked_label("browser-a/b").is_err());
        assert!(checked_label("browser-é").is_err());
    }

    #[test]
    fn only_web_addresses_are_accepted() {
        assert!(web_url("https://claude.ai/").is_ok());
        assert!(web_url("http://localhost:5173").is_ok());
        assert!(web_url("file:///etc/passwd").is_err());
        assert!(web_url("javascript:alert(1)").is_err());
        assert!(web_url("tauri://localhost").is_err());
        assert!(web_url("https://a.com/\u{7}").is_err());
    }
}

// TEMP-DEBUG
#[tauri::command]
pub fn browser_debug(message: String) {
    eprintln!("[browser-debug] js: {message}");
}
