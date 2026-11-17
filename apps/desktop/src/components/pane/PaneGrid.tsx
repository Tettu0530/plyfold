import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { EVEN_SPLIT, useStore, type PaneCount, type Split } from "@/state/store";
import { interactive, smooth } from "../motion";
import { Pane } from "./Pane";

/** Panes never get narrower or shorter than this while dragging a boundary (px) */
const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Layout per pane count (%), split at the given ratios */
function rects(count: PaneCount, split: Split): Rect[] {
  const x = split.x * 100;
  const y = split.y * 100;
  if (count === 1) return [{ left: 0, top: 0, width: 100, height: 100 }];
  if (count === 2)
    return [
      { left: 0, top: 0, width: x, height: 100 },
      { left: x, top: 0, width: 100 - x, height: 100 },
    ];
  return [
    { left: 0, top: 0, width: x, height: y },
    { left: x, top: 0, width: 100 - x, height: y },
    { left: 0, top: y, width: x, height: 100 - y },
    { left: x, top: y, width: 100 - x, height: 100 - y },
  ];
}

/**
 * The boundary between panes. Drag it to resize (the panes follow the pointer), double-click it to split evenly again,
 * or focus it and use the arrow keys
 */
function Divider({ axis, value, area, onDragging }: { axis: "x" | "y"; value: number; area: React.RefObject<HTMLElement | null>; onDragging: (d: boolean) => void }) {
  const t = useT();
  const setSplit = useStore((s) => s.setSplit);
  const [active, setActive] = useState(false);
  // The drag flag is a ref so a move right after the press sees it (state would only update on the next render)
  const dragging = useRef(false);
  const vertical = axis === "x";
  // Ratio from the pointer position, keeping both sides at least their minimum size
  const ratioAt = (e: React.PointerEvent) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return value;
    const size = vertical ? r.width : r.height;
    const min = Math.min(0.45, (vertical ? MIN_WIDTH : MIN_HEIGHT) / size);
    const v = ((vertical ? e.clientX - r.left : e.clientY - r.top) / size);
    return Math.min(1 - min, Math.max(min, v));
  };
  const pos = `${value * 100}%`;
  return (
    <motion.div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={t(vertical ? "pane.resizeWidth" : "pane.resizeHeight")}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      title={t("pane.resizeHint")}
      tabIndex={0}
      animate={vertical ? { left: pos } : { top: pos }}
      transition={active ? { duration: 0 } : smooth}
      onPointerDown={(e) => {
        // Don't start a text selection (it would select the panes' text while dragging)
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic events have no capturable pointer; dragging still works while the pointer stays over the boundary
        }
        dragging.current = true;
        document.body.classList.add("resizing");
        setActive(true);
        onDragging(true);
      }}
      onPointerMove={(e) => {
        if (dragging.current) setSplit({ [axis]: ratioAt(e) });
      }}
      onPointerUp={() => {
        dragging.current = false;
        document.body.classList.remove("resizing");
        setActive(false);
        onDragging(false);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        document.body.classList.remove("resizing");
        setActive(false);
        onDragging(false);
      }}
      onDoubleClick={() => setSplit({ [axis]: EVEN_SPLIT[axis] })}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        const dir: Record<string, number> = vertical ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
        const d = dir[e.key];
        if (d) {
          e.preventDefault();
          setSplit({ [axis]: value + d * step });
        } else if (e.key === "Enter") setSplit({ [axis]: EVEN_SPLIT[axis] });
      }}
      className={cn(
        "group absolute z-10 flex items-center justify-center outline-none",
        vertical ? "top-0 bottom-0 -ml-1 w-2 cursor-col-resize" : "right-0 left-0 -mt-1 h-2 cursor-row-resize",
      )}
    >
      {/* A thin line that shows on hover, focus and while dragging (the pane borders draw the resting line) */}
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-foreground/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
          vertical ? "h-full w-0.5" : "h-0.5 w-full",
          active && "opacity-100",
        )}
      />
    </motion.div>
  );
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
  const split = useStore((s) => s.split);
  const layout = rects(count, split);
  const area = useRef<HTMLElement>(null);
  // While a boundary is dragged, panes follow the pointer instead of springing to it
  const [dragging, setDragging] = useState(false);
  return (
    <main ref={area} className="relative min-w-0 grow overflow-hidden">
      <AnimatePresence initial={false}>
        {layout.map((r, i) => (
          <motion.div
            key={i}
            // A new pane appears from the right edge (bottom edge for the lower row) at zero width and expands; a removed one shrinks back there
            initial={{ ...pct(collapsed(r)), opacity: 0 }}
            animate={{ ...pct(r), opacity: 1 }}
            exit={{ ...pct(collapsed(r)), opacity: 0 }}
            transition={dragging ? interactive : smooth}
            data-pane-index={i}
            className="absolute flex overflow-hidden border-r border-b [&>div>section]:min-w-[280px] [&>div>section]:grow"
            style={{ contain: "layout paint" }}
          >
            <Pane index={i} />
          </motion.div>
        ))}
      </AnimatePresence>
      {count > 1 && <Divider axis="x" value={split.x} area={area} onDragging={setDragging} />}
      {count === 4 && <Divider axis="y" value={split.y} area={area} onDragging={setDragging} />}
    </main>
  );
}
