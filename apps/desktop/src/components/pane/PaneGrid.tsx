import { AnimatePresence, motion } from "motion/react";
import { Fragment, useRef, useState } from "react";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { leaves, type LayoutNode } from "@/state/layout";
import { useStore } from "@/state/store";
import { smooth } from "../motion";
import { Pane } from "./Pane";

/** Panes never get narrower or shorter than this while dragging a divider (px) */
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

/** Stable key for a child: its first slot (so a pane keeps its component while the tree around it changes) */
const keyOf = (n: LayoutNode) => (n.kind === "leaf" ? `leaf-${n.slot}` : `split-${leaves(n)[0]}`);

/**
 * The divider between children i-1 and i of a split. Drag it to move the boundary (only these two children change),
 * double-click or press Enter to make them equal, or focus it and use the arrow keys
 */
function Divider({ path, index, axis, sizes, container, onDragging }: { path: number[]; index: number; axis: "row" | "column"; sizes: number[]; container: React.RefObject<HTMLElement | null>; onDragging: (d: boolean) => void }) {
  const t = useT();
  const setSplitSizes = useStore((s) => s.setSplitSizes);
  const [active, setActive] = useState(false);
  // A ref so a move right after the press sees it (state only updates on the next render)
  const dragging = useRef(false);
  const vertical = axis === "row";
  const pair = sizes[index - 1] + sizes[index];
  const setFirst = (first: number) => {
    const next = [...sizes];
    next[index - 1] = first;
    next[index] = pair - first;
    setSplitSizes(path, next);
  };
  const minFraction = () => {
    const r = container.current?.getBoundingClientRect();
    const size = r ? (vertical ? r.width : r.height) : 1000;
    return Math.min(pair / 2, (vertical ? MIN_WIDTH : MIN_HEIGHT) / size);
  };
  const ratioAt = (e: React.PointerEvent) => {
    const r = container.current?.getBoundingClientRect();
    if (!r) return sizes[index - 1];
    const size = vertical ? r.width : r.height;
    const before = sizes.slice(0, index - 1).reduce((a, b) => a + b, 0);
    const v = ((vertical ? e.clientX - r.left : e.clientY - r.top) / size) - before;
    const min = minFraction();
    return Math.min(pair - min, Math.max(min, v));
  };
  const end = () => {
    dragging.current = false;
    document.body.classList.remove("resizing");
    setActive(false);
    onDragging(false);
  };
  return (
    <div className={cn("relative z-10 shrink-0", vertical ? "w-0" : "h-0")}>
      <div
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-label={t(vertical ? "pane.resizeWidth" : "pane.resizeHeight")}
        aria-valuenow={Math.round((sizes[index - 1] / pair) * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        title={t("pane.resizeHint")}
        tabIndex={0}
        onPointerDown={(e) => {
          // Don't start a text selection (it would select the panes' text while dragging)
          e.preventDefault();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Synthetic events have no capturable pointer
          }
          dragging.current = true;
          document.body.classList.add("resizing");
          setActive(true);
          onDragging(true);
        }}
        onPointerMove={(e) => {
          if (dragging.current) setFirst(ratioAt(e));
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => setFirst(pair / 2)}
        onKeyDown={(e) => {
          const step = (e.shiftKey ? 0.1 : 0.02) * pair;
          const dir: Record<string, number> = vertical ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
          const d = dir[e.key];
          if (d) {
            e.preventDefault();
            const min = minFraction();
            setFirst(Math.min(pair - min, Math.max(min, sizes[index - 1] + d * step)));
          } else if (e.key === "Enter") setFirst(pair / 2);
        }}
        className={cn(
          "group absolute flex items-center justify-center outline-none",
          vertical ? "inset-y-0 -left-1 w-2 cursor-col-resize" : "inset-x-0 -top-1 h-2 cursor-row-resize",
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
      </div>
    </div>
  );
}

/**
 * One node of the layout tree. Like Apple's Split View, panes animate their actual size (flex-grow) rather than
 * scaling, so their content is laid out at the real width every frame and text never stretches
 */
function Node({ node, path, dragging, setDragging }: { node: LayoutNode; path: number[]; dragging: boolean; setDragging: (d: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  if (node.kind === "leaf")
    return (
      <div data-pane-index={node.slot} className="relative flex min-h-0 min-w-0 grow overflow-hidden border-r border-b [&>div>section]:min-w-0 [&>div>section]:grow" style={{ contain: "layout paint" }}>
        <Pane index={node.slot} />
      </div>
    );
  return (
    <div ref={ref} className={cn("flex min-h-0 min-w-0 grow", node.axis === "row" ? "flex-row" : "flex-col")}>
      <AnimatePresence initial={false}>
        {node.children.map((child, i) => (
          <Fragment key={keyOf(child)}>
            {i > 0 && <Divider path={path} index={i} axis={node.axis} sizes={node.sizes} container={ref} onDragging={setDragging} />}
            <motion.div
              // A new pane grows from nothing; a removed one shrinks away
              initial={{ flexGrow: 0, opacity: 0 }}
              animate={{ flexGrow: node.sizes[i], opacity: 1 }}
              exit={{ flexGrow: 0, opacity: 0 }}
              transition={dragging ? { duration: 0 } : smooth}
              style={{ flexBasis: 0 }}
              className="flex min-h-0 min-w-0 overflow-hidden"
            >
              <Node node={child} path={[...path, i]} dragging={dragging} setDragging={setDragging} />
            </motion.div>
          </Fragment>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function PaneGrid() {
  const layout = useStore((s) => s.layout);
  // While a divider is dragged, panes follow the pointer instead of springing to it
  const [dragging, setDragging] = useState(false);
  return (
    <main className="relative flex min-w-0 grow overflow-hidden">
      <Node node={layout} path={[]} dragging={dragging} setDragging={setDragging} />
    </main>
  );
}
