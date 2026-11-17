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

/** Layout per pane count (%) */
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

/** Shape before appearing / after disappearing. Top row shrinks to the right edge, bottom row to the bottom edge */
const collapsed = (r: Rect): Rect => (r.top > 0 ? { ...r, top: 100, height: 0 } : { ...r, left: 100, width: 0 });

const pct = (r: Rect) => ({ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` });

/**
 * Like Apple's Split View, panes animate their actual width and height rather than scaling.
 * The content is relaid out at that width every frame, so text never gets stretched
 * (scaling with transform distorts the content, so this is the one place that animates width and height directly)
 */
export function PaneGrid({ count }: { count: PaneCount }) {
  const layout = rects(count);
  return (
    <main className="relative min-w-0 grow overflow-hidden">
      <AnimatePresence initial={false}>
        {layout.map((r, i) => (
          <motion.div
            key={i}
            // A new pane appears from the right edge (bottom edge for the lower row) at zero width and expands; a removed one shrinks back there
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
