import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Fragment, lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { leaves, type LayoutNode } from "@/state/layout";
import { isTerminal, useStore } from "@/state/store";
import { smooth } from "../motion";
import { Pane } from "./Pane";

const TerminalPane = memo(lazy(() => import("./TerminalPane")));

/** Keep tabs and PTYs mounted when a terminal slot moves to a different parent in the layout tree. */
function TerminalPanePortal({ index, id, layout }: { index: number; id: string; layout: LayoutNode }) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex min-h-0 min-w-0 grow";
    return element;
  });

  useLayoutEffect(() => {
    const selector = `[data-terminal-pane-host="${index}"]`;
    const current = container.parentElement;
    if (current?.isConnected && current.matches(selector)) return;
    document.querySelector(selector)?.appendChild(container);
  }, [container, index, layout]);

  useLayoutEffect(() => () => container.remove(), [container]);

  return createPortal(
    <Suspense fallback={null}>
      <TerminalPane index={index} id={id} />
    </Suspense>,
    container,
  );
}

function TerminalPanes({ layout }: { layout: LayoutNode }) {
  const panes = useStore((s) => s.panes);
  return leaves(layout).map((index) => {
    const id = panes[index];
    return isTerminal(id) ? <TerminalPanePortal key={`${index}:${id}`} index={index} id={id} layout={layout} /> : null;
  });
}

/** Panes never get narrower or shorter than this while dragging a divider (px) */
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

/** Stable key for a child: its first slot (so a pane keeps its component while the tree around it changes) */
const keyOf = (n: LayoutNode) => (n.kind === "leaf" ? `leaf-${n.slot}` : `split-${leaves(n)[0]}`);

/**
 * The divider between children i-1 and i of a split. Drag it to move the boundary (only these two children change),
 * double-click or press Enter to make them equal, or focus it and use the arrow keys
 */
function Divider({
  path,
  index,
  axis,
  sizes,
  container,
  onDragging,
}: {
  path: number[];
  index: number;
  axis: "row" | "column";
  sizes: number[];
  container: React.RefObject<HTMLElement | null>;
  onDragging: (d: boolean) => void;
}) {
  const t = useT();
  const setSplitSizes = useStore((s) => s.setSplitSizes);
  const [active, setActive] = useState(false);
  const drag = useRef<{ pointer: number; origin: number; size: number; before: number; min: number; position: number; frame: number | null } | null>(null);
  const vertical = axis === "row";
  const pair = sizes[index - 1] + sizes[index];
  const setFirst = (first: number) => {
    const next = [...sizes];
    next[index - 1] = first;
    next[index] = pair - first;
    setSplitSizes(path, next);
  };
  const applyPosition = (current: NonNullable<typeof drag.current>) => {
    const first = (current.position - current.origin) / current.size - current.before;
    setFirst(Math.min(pair - current.min, Math.max(current.min, first)));
  };
  const end = (e: React.PointerEvent) => {
    const current = drag.current;
    if (!current || current.pointer !== e.pointerId) return;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    const position = e.type === "pointerup" ? (vertical ? e.clientX : e.clientY) : current.position;
    if (current.frame !== null || position !== current.position) {
      current.position = position;
      applyPosition(current);
    }
    drag.current = null;
    document.body.classList.remove("resizing");
    setActive(false);
    onDragging(false);
  };
  useEffect(
    () => () => {
      const current = drag.current;
      if (!current) return;
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      drag.current = null;
      document.body.classList.remove("resizing");
      onDragging(false);
    },
    [onDragging],
  );
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
          if (drag.current || e.button !== 0) return;
          const rect = container.current?.getBoundingClientRect();
          const size = rect && (vertical ? rect.width : rect.height);
          if (!rect || !size) return;
          e.preventDefault();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Synthetic events have no capturable pointer
          }
          drag.current = {
            pointer: e.pointerId,
            origin: vertical ? rect.left : rect.top,
            size,
            before: sizes.slice(0, index - 1).reduce((sum, value) => sum + value, 0),
            min: Math.min(pair / 2, (vertical ? MIN_WIDTH : MIN_HEIGHT) / size),
            position: vertical ? e.clientX : e.clientY,
            frame: null,
          };
          document.body.classList.add("resizing");
          setActive(true);
          onDragging(true);
        }}
        onPointerMove={(e) => {
          const current = drag.current;
          if (!current || current.pointer !== e.pointerId) return;
          current.position = vertical ? e.clientX : e.clientY;
          if (current.frame !== null) return;
          current.frame = requestAnimationFrame(() => {
            current.frame = null;
            applyPosition(current);
          });
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => setFirst(pair / 2)}
        onKeyDown={(e) => {
          const step = (e.shiftKey ? 0.1 : 0.02) * pair;
          const dir: Record<string, number> = vertical ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
          const d = dir[e.key];
          if (d) {
            e.preventDefault();
            const rect = container.current?.getBoundingClientRect();
            const size = rect ? (vertical ? rect.width : rect.height) : 1000;
            const min = Math.min(pair / 2, (vertical ? MIN_WIDTH : MIN_HEIGHT) / size);
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
type NodeProps = { node: LayoutNode; path: number[]; dragging: boolean; setDragging: (d: boolean) => void; present: boolean };

/**
 * A child of a split. While it shrinks away (removed, or moved to another split) the same pane may already be
 * growing in elsewhere, so a leaving child gives up its data-pane-index (drop targets and animations find one pane)
 */
function Child({ size, ...props }: NodeProps & { size: number }) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      // A new pane grows from nothing; a removed one shrinks away
      initial={{ flexGrow: 0, opacity: 0 }}
      animate={{ flexGrow: size, opacity: 1 }}
      exit={{ flexGrow: 0, opacity: 0 }}
      transition={props.dragging ? { duration: 0 } : smooth}
      style={{ flexBasis: 0 }}
      className="flex min-h-0 min-w-0 overflow-hidden"
    >
      <Node {...props} present={props.present && isPresent} />
    </motion.div>
  );
}

const StablePane = memo(Pane);

function Node({ node, path, dragging, setDragging, present }: NodeProps) {
  const ref = useRef<HTMLDivElement>(null);
  if (node.kind === "leaf")
    return (
      <div
        data-pane-index={present ? node.slot : undefined}
        aria-hidden={present ? undefined : true}
        className="relative flex min-h-0 min-w-0 grow overflow-hidden border-r border-b [&>div>section]:min-w-0 [&>div>section]:grow"
        style={{ contain: "layout paint" }}
      >
        <StablePane index={node.slot} present={present} />
      </div>
    );
  return (
    <div ref={ref} className={cn("flex min-h-0 min-w-0 grow", node.axis === "row" ? "flex-row" : "flex-col")}>
      <AnimatePresence initial={false}>
        {node.children.map((child, i) => (
          <Fragment key={keyOf(child)}>
            {i > 0 && <Divider path={path} index={i} axis={node.axis} sizes={node.sizes} container={ref} onDragging={setDragging} />}
            <Child size={node.sizes[i]} node={child} path={[...path, i]} dragging={dragging} setDragging={setDragging} present={present} />
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
      {/* A lone pane is drawn as a split with one child, so splitting it keeps the pane's component (and its
          scroll position and typed text) instead of rebuilding it under a new parent */}
      <Node
        node={layout.kind === "leaf" ? { kind: "split", axis: "row", sizes: [1], children: [layout] } : layout}
        path={[]}
        dragging={dragging}
        setDragging={setDragging}
        present
      />
      <TerminalPanes layout={layout} />
    </main>
  );
}
