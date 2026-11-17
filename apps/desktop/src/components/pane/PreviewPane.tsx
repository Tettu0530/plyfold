// A pane that shows a web page, usually a dev server the agent started (http://localhost:5173 and the like).
// The page runs in a sandboxed iframe inside the app, so menus and animations keep drawing above it.
// Pages that forbid framing (X-Frame-Options / CSP frame-ancestors) stay blank: "Open in browser" opens them outside
import { ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { normalizeUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { startDrag } from "./dnd";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";

/** After this long without a load event, suggest opening the page in a browser */
const SLOW_MS = 8000;

export function PreviewPane({ index, id }: { index: number; id: string }) {
  const t = useT();
  const page = useStore((s) => s.previews[id]);
  const { closePane, focusPane, setPreviewUrl } = useStore.getState();
  const [draft, setDraft] = useState(page?.url ?? "");
  // Changing the key reloads the frame (a cross-origin frame can't be reloaded from here otherwise)
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const url = page?.url ?? "";

  useEffect(() => setDraft(url), [url]);
  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [url, nonce]);

  if (!page) return null;
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
    <section aria-label={t("pane.previewLabel", { url })} onMouseDown={() => focusPane(index)} className="flex min-w-0 flex-col">
      {/* Right-click: split, even out, close */}
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(e) => startDrag(e, () => ({ kind: "pane", slot: index, title: url }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-1.5 border-b pr-1.5 pl-3"
        >
          <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
            onFocus={(e) => e.currentTarget.select()}
            className="h-6 min-w-0 grow rounded-md bg-transparent px-1.5 font-mono text-xs outline-none focus:bg-background focus:outline focus:outline-ring"
          />
          <button type="button" aria-label={t("pane.previewReload")} title={t("pane.previewReload")} onClick={() => setNonce((n) => n + 1)} className={ICON}>
            <RotateCw className="size-3.5" aria-hidden />
          </button>
          <button type="button" aria-label={t("pane.previewExternal")} title={t("pane.previewExternal")} onClick={openOutside} className={ICON}>
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
          <button type="button" aria-label={t("common.close")} onClick={() => closePane(index)} className={ICON}>
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </PaneMenu>
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
          <div className={cn("pointer-events-none absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground transition-opacity duration-150")}>
            <p className="m-0 max-w-sm px-6 text-center">{slow ? t("pane.previewSlow") : t("pane.previewLoading")}</p>
          </div>
        )}
      </div>
    </section>
  );
}

const ICON = "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground";
