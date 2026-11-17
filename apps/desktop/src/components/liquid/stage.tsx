// Entry point for the standard separation animations (.claude/skills/no-ai-slop-ui, section 4: motion)
//
//   liquidOpen("pane-0", { anchor: "session:<id>", target: () => el })   … emerge from behind the anchor and expand into the target
//   liquidClose("pane-0")                                                … shrink from the target back behind the anchor
//   liquidCloseFrom("pane-0", { anchor, target })                        … send the visible surface back to the anchor with a close animation
//   useLiquidRevealed("pane-0")                                          … whether the real surface may be shown (false while animating)
//
// Blobs are all drawn by the single <LiquidStage /> mounted in the app.
import { useMotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { useStore } from "@/state/store";
import { liquidAnchorElement, useLiquidMorph, type Look } from "./liquid";

export interface LiquidJobOptions {
  anchor: string;
  target: () => HTMLElement | null;
  radius?: number;
  anchorRadius?: number;
  /** Blob z-index: 55, below anchors (57) and above the sidebar background */
  zIndex?: number;
  /** Delay before starting (ms). The target's content stays hidden while waiting */
  delay?: number;
  /** Called when the animation ends (for a close, tear down the target here) */
  onDone?: () => void;
  /**
   * For a target large enough to cover the anchor (full screens). The anchor is raised in front only
   * at the start of opening and the end of closing (so the button isn't left on top of the expanded blob)
   */
  cover?: boolean;
  /**
   * For targets that open overlapping the anchor, like menus. It starts from behind the anchor and
   * moves the blob on top midway (open amount 0.2-0.5); closing reverses this, dropping back behind midway
   */
  rise?: boolean;
  /** Keep drawing the blob as the real surface's frame after opening (menus). Stays registered until closed */
  hold?: boolean;
  fromLook?: Look;
  toLook?: Look;
}

interface Job extends LiquidJobOptions {
  id: string;
  open: boolean;
  initiallyOpen: boolean;
  /** Counter used to recreate the job when reopened with the same id */
  nonce: number;
  /** With cover / rise: whether the anchor is currently lowered beneath the blob */
  lowered?: boolean;
  /** Fully open with the real surface shown, but the liquid bridge's tail hasn't fully retracted */
  lingering?: boolean;
}

interface StageState {
  jobs: Record<string, Job>;
  revealed: Record<string, boolean>;
}

// Keep a single registry even if HMR loads this module twice
const gs = globalThis as { __plyfoldStage?: ReturnType<typeof createStage> };
function createStage() {
  return create<StageState>(() => ({ jobs: {}, revealed: {} }));
}
const useStage = (gs.__plyfoldStage ??= createStage());
let nonce = 0;

export function liquidOpen(id: string, opts: LiquidJobOptions) {
  useStage.setState((s) => ({
    jobs: { ...s.jobs, [id]: { ...opts, id, open: true, initiallyOpen: false, nonce: ++nonce } },
    revealed: { ...s.revealed, [id]: false },
  }));
}

export function liquidClose(id: string) {
  useStage.setState((s) => (s.jobs[id] ? { jobs: { ...s.jobs, [id]: { ...s.jobs[id], open: false } } } : s));
}

/** Send the visible surface back to its anchor with a close animation (works for surfaces not opened with liquidOpen) */
export function liquidCloseFrom(id: string, opts: LiquidJobOptions) {
  useStage.setState((s) => ({
    // Starts open, so with cover / rise the anchor begins beneath the blob
    jobs: { ...s.jobs, [id]: { ...opts, id, open: false, initiallyOpen: true, nonce: ++nonce, lowered: !!(opts.cover || opts.rise) } },
    revealed: { ...s.revealed, [id]: false },
  }));
}

/** Whether the surface for id may be shown. true if no animation is registered */
export function useLiquidRevealed(id: string): boolean {
  return useStage((s) => (s.jobs[id] ? !!s.revealed[id] : true));
}

/** Whether any separation animation is running (to raise the sidebar above the blob) */
export function useLiquidBusy(): boolean {
  return useStage((s) => Object.keys(s.jobs).length > 0);
}

/** Names of anchors that should currently sit above the blob (they get z-[57]) */
export function useLiquidActiveAnchors(): Set<string> {
  const key = useStage((s) =>
    Object.values(s.jobs)
      .filter((j) => !j.lowered)
      .map((j) => j.anchor)
      .sort()
      .join("\n"),
  );
  return new Set(key ? key.split("\n") : []);
}

/** Names of anchors with a running animation, including lowered ones (so they keep the selected color) */
export function useLiquidMovingAnchors(): Set<string> {
  const key = useStage((s) =>
    Object.values(s.jobs)
      .map((j) => j.anchor)
      .sort()
      .join("\n"),
  );
  return new Set(key ? key.split("\n") : []);
}

type Edges = ReturnType<typeof useLiquidMorph>["edges"];
const liveEdges = new Map<string, Edges>();
// For development checks (tools/liquid-probe's PROBE reads the blob shape)
if (import.meta.env.DEV) (globalThis as { __plyfoldLiveEdges?: Map<string, Edges> }).__plyfoldLiveEdges = liveEdges;

/** Whether the separation animation for id is running */
export function useLiquidActive(id: string): boolean {
  return useStage((s) => !!s.jobs[id] && !s.jobs[id].lingering);
}

/**
 * For full screens: while animating, clip the screen to the blob's shape and fade it in as it expands
 * (fading out as it shrinks on close). Content appears without waiting for full expansion
 */
export function useLiquidClip(id: string, ref: React.RefObject<HTMLElement | null>) {
  const active = useLiquidActive(id);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    // The target may not exist right after opening (menus, etc.), so look it up every frame.
    // Remember the original values and restore them afterwards (don't clobber styles React set)
    let el: HTMLElement | null = null;
    const KEYS = ["clipPath", "opacity", "transition", "animation", "background", "borderColor", "boxShadow", "backdropFilter"] as const;
    let saved: Partial<Record<(typeof KEYS)[number], string>> | null = null;
    const tick = () => {
      el = ref.current ?? el;
      if (el && !saved) {
        saved = Object.fromEntries(KEYS.map((k) => [k, el!.style[k]]));
        // While animating, the liquid blob is the only "body" (hide the real background, border and shadow).
        // With both present, spring overshoot makes their sizes diverge and a gap shows between them
        el.style.background = "transparent";
        el.style.borderColor = "transparent";
        el.style.boxShadow = "none";
        el.style.backdropFilter = "none";
      }
      const e = liveEdges.get(id);
      const box = el?.getBoundingClientRect();
      if (el && e && box && box.width > 0) {
        const l = e.L.get(), t = e.T.get(), r = e.R.get(), b = e.B.get();
        const top = Math.max(0, t - box.top);
        const left = Math.max(0, l - box.left);
        const right = Math.max(0, box.right - r);
        const bottom = Math.max(0, box.bottom - b);
        el.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${e.rad.get()}px)`;
        // Reveal by area ratio (fade in between 30% and 80% of full size).
        // An anchor about as large as the target (e.g. a right-clicked row) starts with enough area, so also cap by open amount
        const k = Math.min(1, Math.max(0, ((r - l) * (b - t)) / (box.width * box.height)));
        const x = Math.min(1, Math.max(0, (k - 0.3) / 0.5), Math.max(0, (e.look.get() - 0.3) / 0.5));
        el.style.opacity = String(x * x * (3 - 2 * x));
        el.style.transition = "none";
        el.style.animation = "none";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (!el || !saved) return;
      for (const k of KEYS) el.style[k] = saved[k] ?? "";
    };
  }, [active, id, ref]);
  return active;
}

const CHIP_LOOK: Look = { background: "rgba(38, 38, 38, 1)", border: "rgba(255, 255, 255, 0)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
const MENU_LOOK: Look = { background: "rgba(23, 23, 23, 1)", border: "rgba(255, 255, 255, 0.1)", shadow: "0px 4px 12px rgba(0, 0, 0, 0.45)", blur: 0 };

/** Always disable Radix's default fade/zoom (inline, since classes can't override it).
 * Without an animation, Radix unmounts content immediately on close (it doesn't linger for its own fade) */
const NO_ANIMATION: React.CSSProperties = { animation: "none" };

/**
 * For small menus (Select / Popover). Expands out of the anchor chip and shrinks back on close.
 * Radix removes content immediately on close, so the close animation shrinks from the last size.
 * Usage: `const m = useLiquidMenu(id, anchorName)`, then `ref={liquidAnchor(anchorName)}` on the chip,
 * `onOpenChange={m.onOpenChange}` on Root, and `ref={m.ref}`, `style={m.style}`, z-[58] on Content
 */
export function useLiquidMenu(id: string, anchor: string) {
  const ref = useRef<HTMLElement | null>(null);
  // Hide from the first frame while animating (useLiquidClip overwrites the fade every frame)
  const moving = useLiquidClip(id, ref);
  const onOpenChange = (open: boolean) => {
    // Match the anchor's corner radius to the real one (otherwise mismatched corners show when it's lowered midway)
    const el0 = liquidAnchorElement(anchor);
    const anchorRadius = (el0 && parseFloat(getComputedStyle(el0).borderTopLeftRadius)) || 6;
    // hold: the blob stays as the frame after opening (no real background/border/shadow). With no swap, springs can't misalign them
    const base = { anchor, radius: 8, anchorRadius, fromLook: CHIP_LOOK, toLook: MENU_LOOK, rise: true, hold: true };
    if (open) {
      liquidOpen(id, { ...base, target: () => ref.current });
      return;
    }
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ghost = { getBoundingClientRect: () => rect } as unknown as HTMLElement;
    liquidCloseFrom(id, { ...base, target: () => ghost });
  };
  return { ref, onOpenChange, moving, style: NO_ANIMATION };
}

/** Wait before starting, if a delay is given */
function DelayedJob({ job }: { job: Job }) {
  const [ready, setReady] = useState(!job.delay);
  useEffect(() => {
    if (!job.delay) return;
    const t = setTimeout(() => setReady(true), job.delay);
    return () => clearTimeout(t);
  }, [job.delay]);
  return ready ? <JobView job={job} /> : null;
}

function JobView({ job }: { job: Job }) {
  const style = useStore((s) => s.liquidStyle);
  const sizeLag = useStore((s) => s.liquidLag);
  // The target is a function, re-evaluated on every measurement
  const targetRef = useRef({
    get current() {
      return job.target();
    },
  }).current as React.RefObject<HTMLElement | null>;
  // How much the blob sits over the anchor (cover / rise). Surfaces that start lowered begin at 1
  const over = useMotionValue(job.lowered ? 1 : 0);
  const { revealed, mounted, holding, layer, edges, settling } = useLiquidMorph(job.open, {
    anchor: job.anchor,
    target: targetRef,
    radius: job.radius ?? 0,
    anchorRadius: job.anchorRadius ?? 8,
    zIndex: job.zIndex ?? 55,
    style,
    sizeLag,
    initiallyOpen: job.initiallyOpen,
    over,
    hold: !!job.hold,
    ...(job.fromLook ? { fromLook: job.fromLook } : {}),
    ...(job.toLook ? { toLook: job.toLook } : {}),
  });

  useEffect(() => {
    useStage.setState((s) => ({ revealed: { ...s.revealed, [job.id]: revealed } }));
  }, [revealed, job.id]);

  // Expose the blob's shape to the target screen (useLiquidClip)
  useEffect(() => {
    liveEdges.set(job.id, edges);
    return () => {
      if (liveEdges.get(job.id) === edges) liveEdges.delete(job.id);
    };
  }, [job.id, edges]);

  // Lower the anchor (put the blob on top). While lowered, the GPU renderer also paints the blob over the anchor
  useEffect(() => {
    if (!job.cover && !job.rise) return;
    const setLowered = (lowered: boolean) =>
      useStage.setState((s) => {
        const j = s.jobs[job.id];
        if (j?.nonce !== job.nonce || !!j.lowered === lowered) return s;
        return { jobs: { ...s.jobs, [job.id]: { ...j, lowered } } };
      });
    if (job.rise) {
      // Menus: move on top midway based on open amount (blended over 0.2-0.5 rather than switched instantly)
      const update = (v: number) => {
        const x = Math.min(1, Math.max(0, (v - 0.2) / 0.3));
        const o = x * x * (3 - 2 * x);
        over.set(o);
        setLowered(o > 0);
      };
      update(edges.look.get());
      return edges.look.on("change", update);
    }
    // Full screens: raise the anchor only while emerging from behind it at the start or returning at the end
    const lower = (lowered: boolean) => {
      over.set(lowered ? 1 : 0);
      setLowered(lowered);
    };
    lower(!job.open);
    const t = setTimeout(() => lower(job.open), job.open ? 150 : 300);
    return () => clearTimeout(t);
  }, [job.cover, job.rise, job.open, job.id, job.nonce, edges, over]);

  // Unregister once fully open or fully closed (an opened surface stays visible).
  // After opening, stay until the liquid bridge's tail has retracted (with clipping and click blocking lifted meanwhile)
  useEffect(() => {
    // Don't unregister while the blob serves as the frame (a close animation replaces the registration)
    if (job.open && holding) return;
    if (job.open && revealed && settling) {
      useStage.setState((s) => (s.jobs[job.id]?.nonce === job.nonce && !s.jobs[job.id].lingering ? { jobs: { ...s.jobs, [job.id]: { ...s.jobs[job.id], lingering: true } } } : s));
      return;
    }
    if ((job.open && revealed) || (!job.open && !mounted)) {
      useStage.setState((s) => {
        if (s.jobs[job.id]?.nonce !== job.nonce) return s;
        const jobs = { ...s.jobs };
        delete jobs[job.id];
        const rv = { ...s.revealed };
        delete rv[job.id];
        queueMicrotask(() => job.onDone?.());
        return { jobs, revealed: rv };
      });
    }
  }, [job.open, revealed, mounted, settling, holding, job.id, job.nonce]);

  return layer;
}

export function LiquidStage() {
  const jobs = useStage((s) => s.jobs);
  return (
    <>
      {Object.values(jobs).map((j) => (
        <DelayedJob key={`${j.id}:${j.nonce}`} job={j} />
      ))}
    </>
  );
}
