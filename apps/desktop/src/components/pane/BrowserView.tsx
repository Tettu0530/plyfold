// The browser pane's page as a native webview laid over the pane (see src-tauri/src/browser.rs).
// A native view is always drawn above the page's HTML, so this keeps it on the pane's rectangle, and hides it while
// something of the app is drawn over that rectangle (a menu, a dialog, a pane being dragged).
import { useEffect, useRef } from "react";

import { browser, type BrowserRect } from "@/lib/api";
import { useStore } from "@/state/store";

/** The app's own overlays: the page is hidden while one of them covers it */
const OVERLAYS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]';

/** Calls to one browser run in the order they were made (commands may otherwise overtake each other) */
const chains = new Map<string, Promise<unknown>>();
function serial(label: string, call: () => Promise<unknown>) {
  const next = (chains.get(label) ?? Promise.resolve()).then(call, call).catch(() => {});
  chains.set(label, next);
  return next;
}

function coveredBy(box: DOMRect, own: HTMLElement): boolean {
  if (document.body.classList.contains("dragging")) return true;
  for (const o of document.querySelectorAll<HTMLElement>(OVERLAYS)) {
    if (own.contains(o) || o.querySelector('[role="tooltip"]')) continue;
    const b = o.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.left < box.right && b.right > box.left && b.top < box.bottom && b.bottom > box.top) return true;
  }
  return false;
}

export function BrowserView({ label, url, nonce, current }: { label: string; url: string; nonce: number; current: React.RefObject<string> }) {
  const box = useRef<HTMLDivElement>(null);
  const scale = useStore((s) => (s.settings.ui_scale ?? 100) / 100);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // The latest address, for the open call (the effect that opens runs once per pane)
  const urlRef = useRef(url);
  urlRef.current = url;
  const rect = useRef<(() => BrowserRect) | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let raf = 0;
    let until = 0;
    let lastRect = "";
    let visible: boolean | null = null;
    const measure = (): BrowserRect => {
      const r = el.getBoundingClientRect();
      const f = scaleRef.current;
      return { x: r.left * f, y: r.top * f, width: r.width * f, height: r.height * f };
    };
    rect.current = measure;
    const tick = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const hide = r.width < 2 || r.height < 2 || coveredBy(r, el);
      if (!hide) {
        const m = measure();
        const key = `${m.x.toFixed(1)},${m.y.toFixed(1)},${m.width.toFixed(1)},${m.height.toFixed(1)}`;
        if (key !== lastRect) {
          lastRect = key;
          void serial(label, () => browser.bounds(label, m));
        }
      }
      if (visible !== !hide) {
        visible = !hide;
        void serial(label, () => browser.show(label, !hide));
      }
      // While panes are dragged or resized the rectangle changes every frame
      if (document.body.classList.contains("resizing")) until = Math.max(until, performance.now() + 100);
      if (performance.now() < until) raf = requestAnimationFrame(tick);
    };
    const wake = (ms = 600) => {
      until = Math.max(until, performance.now() + ms);
      if (!raf) raf = requestAnimationFrame(tick);
    };
    void serial(label, () => browser.open(label, urlRef.current, measure()));
    current.current = urlRef.current;
    const ro = new ResizeObserver(() => wake());
    ro.observe(el);
    const mo = new MutationObserver(() => wake(300));
    // Menus and dialogs are portalled into the body; classes on it mark drags and resizes
    mo.observe(document.body, { childList: true, attributes: true, attributeFilter: ["class"] });
    const onResize = () => wake();
    window.addEventListener("resize", onResize);
    // Layout moves that raise no event (animated panes)
    const poll = setInterval(() => wake(60), 400);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(poll);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", onResize);
      rect.current = null;
      void serial(label, () => browser.close(label));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens once per pane; later changes arrive through the effects below
  }, [label]);

  // The address changed from the field (or a link that asked for a new window): not when the page itself navigated
  useEffect(() => {
    if (url === current.current) return;
    current.current = url;
    void serial(label, () => browser.navigate(label, url));
  }, [label, url, current]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void serial(label, () => browser.reload(label));
  }, [label, nonce]);

  // The zoom of the UI changed: the rectangle in window coordinates moved with it
  useEffect(() => {
    const m = rect.current?.();
    if (m) void serial(label, () => browser.bounds(label, m));
  }, [label, scale]);

  return <div ref={box} className="absolute inset-0 bg-background" />;
}
