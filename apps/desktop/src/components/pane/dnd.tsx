// Drag and drop for panes, built on pointer events (Tauri takes over the webview's native drag-and-drop for files,
// so HTML5 drag events are not reliable here).
//
// Sources: a session row in the sidebar, or a pane's header (any pane: session, draft or preview).
// Targets: a pane. Its center opens the session there / swaps the two panes; its edges split it in that direction.
// While dragging, the target pane is blurred and the drop area is outlined with a label saying what will happen.
// esc cancels. A drag starts only after the pointer moves a few pixels, so clicks stay clicks
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, ArrowLeftRight, PanelTop } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { create } from "zustand";

import { useT, type MessageKey } from "@/i18n";
import type { Edge } from "@/state/layout";
import { useStore } from "@/state/store";
import { ProviderLogo } from "../icons";
import { snappy } from "../motion";

export type Zone = Edge | "center";
export type DragItem = { kind: "session"; id: string; title: string; agent: string } | { kind: "pane"; slot: number; title: string; agent?: string };

interface DragState {
  item: DragItem | null;
  x: number;
  y: number;
  target: { slot: number; zone: Zone; rect: DOMRect } | null;
}

const useDrag = create<DragState>(() => ({ item: null, x: 0, y: 0, target: null }));

/** Distance the pointer must move before a press becomes a drag (px) */
const THRESHOLD = 5;
/** Edge band that splits the pane (fraction of its width or height) */
const EDGE = 0.25;
/** Splitting must leave both halves at least this big (px) */
const MIN_W = 240;
const MIN_H = 160;

function hitTest(x: number, y: number): DragState["target"] {
  for (const el of document.querySelectorAll<HTMLElement>("[data-pane-index]")) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const slot = Number(el.dataset.paneIndex);
    const rx = (x - r.left) / r.width;
    const ry = (y - r.top) / r.height;
    const d: [Zone, number][] = [
      ["left", rx],
      ["right", 1 - rx],
      ["top", ry],
      ["bottom", 1 - ry],
    ];
    d.sort((a, b) => a[1] - b[1]);
    let zone: Zone = d[0][1] < EDGE ? d[0][0] : "center";
    // Too small to split: drop in the center instead
    if ((zone === "left" || zone === "right") && r.width / 2 < MIN_W) zone = "center";
    if ((zone === "top" || zone === "bottom") && r.height / 2 < MIN_H) zone = "center";
    return { slot, zone, rect: r };
  }
  return null;
}

function drop(item: DragItem, target: NonNullable<DragState["target"]>) {
  const s = useStore.getState();
  const { slot, zone } = target;
  if (item.kind === "session") {
    const from = `session:${item.id}`;
    if (zone === "center") void s.openInPane(item.id, slot, from);
    else s.splitPane(slot, zone, item.id, from);
    return;
  }
  if (item.slot === slot) return;
  s.movePane(item.slot, slot, zone);
}

/**
 * Pointer-down handler that turns a press into a drag once the pointer moves. Ignores presses on buttons, inputs and
 * links inside the source (so its controls keep working)
 */
export function startDrag(e: React.PointerEvent, item: () => DragItem | null) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, input, textarea, select, [role=separator]")) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      const it = item();
      if (!it) return stop();
      started = true;
      document.body.classList.add("resizing", "dragging");
      useDrag.setState({ item: it });
    }
    useDrag.setState({ x: ev.clientX, y: ev.clientY, target: hitTest(ev.clientX, ev.clientY) });
  };
  const up = () => {
    const { item: it, target } = useDrag.getState();
    if (started && it && target) drop(it, target);
    stop();
    // The click that follows a drag must not also open the row
    if (started) window.addEventListener("click", swallow, { capture: true, once: true });
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      stop();
    }
  };
  const swallow = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("keydown", key, true);
    document.body.classList.remove("resizing", "dragging");
    useDrag.setState({ item: null, target: null });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("keydown", key, true);
}

const LABELS: Record<Zone, { key: MessageKey; Icon: typeof PanelTop }> = {
  center: { key: "pane.dropOpen", Icon: PanelTop },
  left: { key: "pane.dropLeft", Icon: ArrowLeftToLine },
  right: { key: "pane.dropRight", Icon: ArrowRightToLine },
  top: { key: "pane.dropTop", Icon: ArrowUpToLine },
  bottom: { key: "pane.dropBottom", Icon: ArrowDownToLine },
};

/** The part of the pane the drop will occupy */
function zoneRect(r: DOMRect, zone: Zone) {
  const inset = 8;
  const half = (v: number) => v / 2;
  const box = { left: r.left, top: r.top, width: r.width, height: r.height };
  if (zone === "left") box.width = half(r.width);
  if (zone === "right") {
    box.left = r.left + half(r.width);
    box.width = half(r.width);
  }
  if (zone === "top") box.height = half(r.height);
  if (zone === "bottom") {
    box.top = r.top + half(r.height);
    box.height = half(r.height);
  }
  return { x: box.left + inset, y: box.top + inset, width: box.width - inset * 2, height: box.height - inset * 2 };
}

/** Mounted once in the app: the blurred target, the outlined drop area with its label, and the dragged card */
export function DragLayer() {
  const t = useT();
  const { item, x, y, target } = useDrag();
  const swap = item?.kind === "pane" && target?.zone === "center";
  const same = item?.kind === "pane" && target?.slot === item.slot;
  const label = target ? (swap ? { key: "pane.dropSwap" as MessageKey, Icon: ArrowLeftRight } : LABELS[target.zone]) : null;
  return (
    <>
      <AnimatePresence>
        {item && target && !same && (
          <motion.div
            key={`blur-${target.slot}`}
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none fixed z-[70] bg-background/40 backdrop-blur-[3px]"
            style={{ left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {item && target && !same && label && (
          <motion.div
            key="zone"
            role="status"
            initial={{ opacity: 0, ...zoneRect(target.rect, target.zone) }}
            animate={{ opacity: 1, ...zoneRect(target.rect, target.zone) }}
            exit={{ opacity: 0 }}
            transition={snappy}
            className="pointer-events-none fixed top-0 left-0 z-[71] flex items-center justify-center rounded-[10px] border-2 border-foreground/40 bg-foreground/5"
          >
            <span className="flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs text-foreground shadow-[0_4px_12px_rgba(0,0,0,.45)]">
              <label.Icon className="size-3.5 text-muted-foreground" aria-hidden />
              {t(label.key)}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      {item && (
        <div
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-[72] flex max-w-56 items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs text-foreground shadow-[0_4px_12px_rgba(0,0,0,.45)]"
          style={{ transform: `translate(${x + 12}px, ${y + 12}px)` }}
        >
          {item.agent && <ProviderLogo agent={item.agent} className="size-3 text-muted-foreground" />}
          <span className="truncate">{item.title}</span>
        </div>
      )}
    </>
  );
}
