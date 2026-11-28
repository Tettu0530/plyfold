// A pane that shows a web page: a dev server the agent started (http://localhost:5173 and the like), or any site.
// In the app the page is a native webview over the pane (BrowserView), so no site is refused for being framed and
// sign-ins persist. In a browser (development) it is a sandboxed iframe, and pages that forbid framing stay blank.
import { ArrowLeft, ArrowRight, ExternalLink, Globe, LoaderCircle, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useT } from "@/i18n";
import { api, browser, inTauri, onBrowserEvent } from "@/lib/api";
import { nativeBrowser } from "@/lib/platform";
import { normalizeUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { useFoundUrls, useSessionPorts } from "../BrowserButton";
import { startDrag } from "./dnd";
import { BrowserView } from "./BrowserView";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";

/** After this long without a load event, suggest opening the page in a browser */
const SLOW_MS = 8000;

export function PreviewPane({ index, id }: { index: number; id: string }) {
  const t = useT();
  const page = useStore((s) => s.previews[id]);
  const { closePane, focusPane, setPreviewUrl } = useStore.getState();
  const [draft, setDraft] = useState(page?.url ?? "");
  // The example in the address bar: the port of the session in focus, when it has one
  const port = useSessionPorts()[0]
    ?.url.replace(/^http:\/\//, "")
    .replace(/\/$/, "");
  // Changing the key reloads the frame (a cross-origin frame can't be reloaded from here otherwise)
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const url = page?.url ?? "";
  // The native webview of this pane. The address the page is at (set by what the page reports, so that it is not loaded twice)
  const label = `browser-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const current = useRef("");
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const draftFocused = useRef(false);

  useEffect(() => {
    if (!nativeBrowser) return;
    let off: (() => void) | undefined;
    let alive = true;
    void onBrowserEvent((e) => {
      if (e.label !== label) return;
      if (e.kind === "navigated" && e.url) {
        current.current = e.url;
        setPreviewUrl(id, e.url);
        setTitle("");
        if (!draftFocused.current) setDraft(e.url);
      } else if (e.kind === "loading") {
        setLoading(true);
        setLoaded(false);
      } else if (e.kind === "loaded") {
        setLoading(false);
        setLoaded(true);
      } else if (e.kind === "title" && e.title) {
        setTitle(e.title);
      } else if (e.kind === "new_window" && e.url) {
        // window.open and target=_blank: shown in this pane
        setPreviewUrl(id, e.url);
      }
    }).then((f) => (alive ? (off = f) : f()));
    return () => {
      alive = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the store actions are stable
  }, [label, id]);

  useEffect(() => setDraft(url), [url]);
  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [url, nonce]);

  if (!page) return null;
  // A new pane starts empty: the URL field is focused and the page lists the URLs agents printed
  const empty = !url;
  const go = () => {
    const next = normalizeUrl(draft);
    if (!next) return;
    if (next === url) setNonce((n) => n + 1);
    else setPreviewUrl(id, next);
  };
  const openOutside = () => {
    if (inTauri) void api.openUrl(url).catch(() => {});
    else window.open(url, "_blank", "noopener");
  };

  return (
    <section
      aria-label={url ? t("pane.previewLabel", { url: title || url }) : t("pane.previewNew")}
      onMouseDown={() => focusPane(index)}
      className="flex min-w-0 flex-col"
    >
      {/* Right-click: split, even out, close */}
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(e) => startDrag(e, () => ({ kind: "pane", slot: index, title: url }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-1.5 border-b pr-1.5 pl-3"
        >
          {nativeBrowser && (
            <>
              <button
                type="button"
                disabled={empty}
                aria-label={t("pane.previewBack")}
                title={t("pane.previewBack")}
                onClick={() => void browser.history(label, -1)}
                className={ICON}
              >
                <ArrowLeft className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                disabled={empty}
                aria-label={t("pane.previewForward")}
                title={t("pane.previewForward")}
                onClick={() => void browser.history(label, 1)}
                className={ICON}
              >
                <ArrowRight className="size-3.5" aria-hidden />
              </button>
            </>
          )}
          {loading ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          ) : (
            <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <input
            aria-label={t("pane.previewUrl")}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                go();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setDraft(url);
                e.currentTarget.blur();
              }
            }}
            onFocus={(e) => {
              draftFocused.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => (draftFocused.current = false)}
            autoFocus={empty}
            placeholder={port ?? t("pane.previewPlaceholder")}
            className="h-6 min-w-0 grow rounded-md bg-transparent px-1.5 font-mono text-xs outline-none focus:bg-background focus:outline focus:outline-ring"
          />
          <button
            type="button"
            disabled={empty}
            aria-label={t("pane.previewReload")}
            title={t("pane.previewReload")}
            onClick={() => setNonce((n) => n + 1)}
            className={ICON}
          >
            <RotateCw className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            disabled={empty}
            aria-label={t("pane.previewExternal")}
            title={t("pane.previewExternal")}
            onClick={openOutside}
            className={ICON}
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
          <button type="button" aria-label={t("common.close")} onClick={() => closePane(index)} className={ICON}>
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </PaneMenu>
      {empty ? (
        <StartPage onOpen={(u) => setPreviewUrl(id, u)} />
      ) : nativeBrowser ? (
        <>
          {/* The page itself is drawn by the native view; what is told about a slow load goes here, above it */}
          {slow && !loaded && <p className="m-0 shrink-0 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{t("pane.previewSlowNative")}</p>}
          <div className="relative min-h-0 grow">
            <BrowserView label={label} url={url} nonce={nonce} current={current} />
          </div>
        </>
      ) : (
        <div className="relative min-h-0 grow bg-white">
          <iframe
            key={`${url}#${nonce}`}
            title={url}
            src={url}
            // The page can run its own scripts, forms and popups, but cannot reach the app (it is a different origin)
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            className="absolute inset-0 size-full border-0"
          />
          {!loaded && (
            <div
              className={cn(
                "pointer-events-none absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground transition-opacity duration-150",
              )}
            >
              <p className="m-0 max-w-sm px-6 text-center">{slow ? t("pane.previewSlow") : t("pane.previewLoading")}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** What an empty browser pane shows: the URLs agents printed in the sessions on screen */
function StartPage({ onOpen }: { onOpen: (url: string) => void }) {
  const t = useT();
  const urls = useFoundUrls();
  const ports = useSessionPorts().filter((p) => !urls.some((u) => u.startsWith(p.url.replace(/\/$/, ""))));
  return (
    <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto px-4 py-4">
      <p className="m-0 text-xs text-muted-foreground">{t("pane.previewStart")}</p>
      {urls.length > 0 && (
        <div className="flex flex-col">
          <span className="pb-1 text-xs font-medium text-muted-foreground">{t("pane.previewFound")}</span>
          {urls.map((u) => (
            <button key={u} type="button" onClick={() => onOpen(u)} className="-mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent">
              <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate font-mono text-xs">{u}</span>
            </button>
          ))}
        </div>
      )}
      {ports.length > 0 && (
        <div className="flex flex-col">
          <span className="pb-1 text-xs font-medium text-muted-foreground">{t("pane.previewPorts")}</span>
          {ports.map((p) => (
            <button
              key={p.url}
              type="button"
              onClick={() => onOpen(p.url)}
              className="-mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent"
            >
              <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="shrink-0 font-mono text-xs">{p.url}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{p.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ICON =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
