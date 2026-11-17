// When files are dropped on the Tauri window, hand them to the receiver under the drop point (a pane's input box).
// Tauri handles file drops itself, so HTML drop events don't work (and wouldn't give paths)
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { inTauri } from "./api";

export interface DropTarget {
  el: () => HTMLElement | null;
  /** Files are hovering over it (true) or have left (false) */
  onOver: (over: boolean) => void;
  onDrop: (paths: string[]) => void;
}

const targets = new Set<DropTarget>();
let started = false;
let hovered: DropTarget | null = null;

function hit(x: number, y: number): DropTarget | null {
  for (const t of targets) {
    const r = t.el()?.getBoundingClientRect();
    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return t;
  }
  return null;
}

function hover(t: DropTarget | null) {
  if (t === hovered) return;
  hovered?.onOver(false);
  hovered = t;
  t?.onOver(true);
}

function start() {
  if (started || !inTauri) return;
  started = true;
  void getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "leave") return hover(null);
    // Position is in physical px; convert to CSS px
    const x = p.position.x / window.devicePixelRatio;
    const y = p.position.y / window.devicePixelRatio;
    const t = hit(x, y);
    if (p.type === "drop") {
      hover(null);
      if (t && p.paths.length) t.onDrop(p.paths);
      return;
    }
    hover(t);
  });
}

/** Register a receiver. Call the returned function to unregister */
export function addDropTarget(t: DropTarget): () => void {
  start();
  targets.add(t);
  return () => {
    targets.delete(t);
    if (hovered === t) hovered = null;
  };
}
