import { AnimatePresence, motion } from "motion/react";

import type { PaneCount } from "@/state/store";
import { smooth } from "../motion";
import { Pane } from "./Pane";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** ペインの数ごとの配置（%） */
function rects(count: PaneCount): Rect[] {
  if (count === 1) return [{ left: 0, top: 0, width: 100, height: 100 }];
  if (count === 2)
    return [
      { left: 0, top: 0, width: 50, height: 100 },
      { left: 50, top: 0, width: 50, height: 100 },
    ];
  return [
    { left: 0, top: 0, width: 50, height: 50 },
    { left: 50, top: 0, width: 50, height: 50 },
    { left: 0, top: 50, width: 50, height: 50 },
    { left: 50, top: 50, width: 50, height: 50 },
  ];
}

/** 現れる前・消えた後の形。上の段は右端へ、下の段は下端へ縮める */
const collapsed = (r: Rect): Rect => (r.top > 0 ? { ...r, top: 100, height: 0 } : { ...r, left: 100, width: 0 });

const pct = (r: Rect) => ({ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` });

/**
 * Apple の分割表示と同じく、ペインの大きさは拡大縮小ではなく実際の幅と高さで動かす。
 * 中身は毎フレームその幅で組み直されるので、文字が引き伸ばされない
 * （transform で拡大縮小すると中身ごと歪むため、ここだけは幅と高さを直接動かす）
 */
export function PaneGrid({ count }: { count: PaneCount }) {
  const layout = rects(count);
  return (
    <main className="relative min-w-0 grow overflow-hidden">
      <AnimatePresence initial={false}>
        {layout.map((r, i) => (
          <motion.div
            key={i}
            // 増えるペインは右端（下の段は下端）から幅 0 で現れて広がり、減るときはそこへ縮む
            initial={{ ...pct(collapsed(r)), opacity: 0 }}
            animate={{ ...pct(r), opacity: 1 }}
            exit={{ ...pct(collapsed(r)), opacity: 0 }}
            transition={smooth}
            data-pane-index={i}
            className="absolute flex overflow-hidden border-r border-b [&>div>section]:min-w-[280px] [&>div>section]:grow"
            style={{ contain: "layout paint" }}
          >
            <Pane index={i} />
          </motion.div>
        ))}
      </AnimatePresence>
    </main>
  );
}
