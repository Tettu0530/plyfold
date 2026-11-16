// Tauri の窓にファイルを落としたとき、落とした場所の上にある受け手（ペインの入力欄）へ渡す。
// Tauri はファイルの落下を自分で受けるので、HTML の drop は使えない（パスも取れない）
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { inTauri } from "./api";

export interface DropTarget {
  el: () => HTMLElement | null;
  /** 上にファイルを持ってきている（true）、離れた（false） */
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
    // 位置は物理 px。CSS の px に直す
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

/** 受け手を登録する。返り値を呼ぶと外す */
export function addDropTarget(t: DropTarget): () => void {
  start();
  targets.add(t);
  return () => {
    targets.delete(t);
    if (hovered === t) hovered = null;
  };
}
