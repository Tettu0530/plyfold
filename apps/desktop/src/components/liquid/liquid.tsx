// Shared building blocks for separation animations (.claude/skills/no-ai-slop-ui, section 4: motion)
//
// Motion for a surface (the target) opening out of what was pressed (the anchor). The shape is four edges,
// each driven by its own spring (so some edges lead and others trail). Styles:
//   morph   : keeps the anchor's shape; the target-side edge stretches first and the far edge follows (close to Apple's menus)
//   tear    : stretches while stuck to the anchor, tears off at the limit and flies into the target shape
//   droplet : shrinks into a round droplet, detaches, travels, then expands
//   pop     : slides out from behind the anchor into the target shape on one spring (default; drawn below the anchor's surface)
// Measurements (tools/liquid-probe) show Apple's morphs move the outer frame on a single spring. Every style uses one spring per stage
import { animate, motion, motionValue, useMotionValue, useReducedMotionConfig, useTransform, useVelocity, type MotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { appleSpring, bouncy, interactive, smooth, snappy, springToCss } from "../motion";
import { addBlob, liquidGlSupported, parseColor, parseShadow } from "./liquid-gl";
import { Adhesion, mergeAt, mergeWidth, PeelSpring, separation } from "./sdf";

type Rect = { l: number; t: number; r: number; b: number };
const rectGap = (a: Rect, s: Rect) => Math.hypot(Math.max(0, s.l - a.r, a.l - s.r), Math.max(0, s.t - a.b, a.t - s.b));

export type LiquidStyle = "pop" | "morph" | "tear" | "droplet";

// ---- Anchor registry (name -> element)
// Keep a single registry even if HMR loads this module twice during development
const g = globalThis as { __plyfoldAnchors?: Map<string, HTMLElement> };
const anchors = (g.__plyfoldAnchors ??= new Map<string, HTMLElement>());

/** Returns a ref that registers the element as a separation anchor */
export function liquidAnchor(name: string) {
  return (el: HTMLElement | null) => {
    if (el) anchors.set(name, el);
    else anchors.delete(name);
  };
}

/** A registered anchor element */
export function liquidAnchorElement(name: string): HTMLElement | undefined {
  return anchors.get(name);
}

const GOO_ID = "plyfold-goo";

/** goo filter definition (mount one per app) */
export function GooDefs() {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: "absolute" }}>
      <defs>
        <filter id={GOO_ID} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" />
        </filter>
      </defs>
    </svg>
  );
}

interface Edges {
  l: number;
  t: number;
  r: number;
  b: number;
  radius: number;
}

function edgesOf(el: Element | null | undefined, radius: number): Edges | null {
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { l: b.left, t: b.top, r: b.right, b: b.bottom, radius };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

type Dir = { x: number; y: number };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const tf = (x: number, y: number, sx: number, sy: number) => `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;

/**
 * The anchor's own body in a separation. It is part of the liquid, not a fixed backdrop:
 * - while the blob is still joined to it by the neck, the anchor is drawn toward the blob and stretched along the pull
 *   (part of it is leaving), and when the neck breaks it springs back from there
 * - when a blob comes home, the anchor takes the impact: pushed away along the blob's direction and squashed, then it
 *   springs back (harder arrivals, bigger reaction)
 * Additive Web Animations, so the anchor's own transforms (press feedback, layout) keep working underneath
 */
/** Rows inside a menu or list do not move: one row tugging out of a column of rows reads as a glitch, and a full-width
 *  row would stick out past the menu's edge */
const STILL_INSIDE = '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';
/** The most an anchor grows or shrinks along an axis, in px: a 10% stretch suits a small round button, but on a wide
 *  chip it would run into its neighbours */
const STRETCH_PX = 4;

class AnchorBody {
  private holding: Animation | null = null;
  private last = { x: 0, y: 0, sx: 1, sy: 1 };
  private el: HTMLElement | null;
  private w = 0;
  private h = 0;
  constructor(el: HTMLElement | null | undefined) {
    this.el = el && !el.closest(STILL_INSIDE) ? el : null;
    if (this.el) {
      const r = this.el.getBoundingClientRect();
      this.w = r.width;
      this.h = r.height;
    }
  }

  /** A scale that changes the anchor's size by at most STRETCH_PX on each axis */
  private capped(sx: number, sy: number) {
    const cap = (s: number, size: number) => (size > 0 ? 1 + Math.sign(s - 1) * Math.min(Math.abs(s - 1), STRETCH_PX / size) : s);
    return { sx: cap(sx, this.w), sy: cap(sy, this.h) };
  }

  /** While joined: `dir` points from the anchor to the blob, `amount` (0..1) is how hard the neck pulls */
  pull(dir: Dir, amount: number) {
    if (!this.el?.animate) return;
    const a = clamp01(amount);
    const ax = Math.abs(dir.x);
    const ay = Math.abs(dir.y);
    // Up to 4px toward the blob, 10% longer along the pull and slightly thinner across it
    this.last = { x: dir.x * 4 * a, y: dir.y * 4 * a, ...this.capped(1 + a * (0.1 * ax - 0.04 * ay), 1 + a * (0.1 * ay - 0.04 * ax)) };
    const t = tf(this.last.x, this.last.y, this.last.sx, this.last.sy);
    const frames = [{ transform: t }, { transform: t }];
    if (!this.holding) {
      this.holding = this.el.animate(frames, { duration: 1000, composite: "add" });
      this.holding.pause();
    } else (this.holding.effect as KeyframeEffect).setKeyframes(frames);
  }

  /** The neck broke: spring back from where the pull left the anchor */
  release(dir: Dir) {
    if (!this.el?.animate) return;
    // At least a clear tug: menus that open over their own button break the neck almost at once, so the pull alone
    // would leave the anchor barely moving
    const ax = Math.abs(dir.x);
    const ay = Math.abs(dir.y);
    const base = { x: dir.x * 3.5, y: dir.y * 3.5, ...this.capped(1 + 0.08 * ax - 0.03 * ay, 1 + 0.08 * ay - 0.03 * ax) };
    const from = this.holding && Math.hypot(this.last.x, this.last.y) > 3.5 ? this.last : base;
    this.stop();
    const { easing, ms } = springToCss({ duration: 0.45, bounce: 0.45 });
    this.el.animate([{ transform: tf(from.x, from.y, from.sx, from.sy) }, { transform: tf(0, 0, 1, 1) }], { duration: ms, easing, composite: "add" });
  }

  /** A blob arrived from `dir` (anchor → blob) at `speed` px/s: take the impact */
  absorb(dir: Dir, speed: number) {
    if (!this.el?.animate) return;
    this.stop();
    const m = Math.min(1, Math.max(0.6, speed / 1000));
    const ax = Math.abs(dir.x);
    const ay = Math.abs(dir.y);
    // Pushed away from the blob and squashed along the hit, bulging across it
    const x = -dir.x * 5 * m;
    const y = -dir.y * 5 * m;
    const { sx, sy } = this.capped(1 + m * (0.08 * ay - 0.12 * ax), 1 + m * (0.08 * ax - 0.12 * ay));
    const { easing, ms } = springToCss({ duration: 0.5, bounce: 0.5 });
    this.el.animate([{ transform: tf(x, y, sx, sy) }, { transform: tf(0, 0, 1, 1) }], { duration: ms, easing, composite: "add" });
  }

  /** Drop the pull without springing (another animation takes over) */
  stop() {
    this.holding?.cancel();
    this.holding = null;
  }
}

const motionValueOf = (v: number) => motionValue(v);
const drop = (cx: number, cy: number, d = 30): Edges => ({ l: cx - d / 2, t: cy - d / 2, r: cx + d / 2, b: cy + d / 2, radius: d / 2 });

type Phase = "closed" | "opening" | "open" | "closing";

interface Options {
  /** Anchor name (registered with liquidAnchor) */
  anchor: string;
  /** Target element (the real surface). Keep it rendered, even when hidden, so it can be measured */
  target: React.RefObject<HTMLElement | null>;
  radius: number;
  anchorRadius?: number;
  /** Blob color (close to the target surface) */
  color?: string;
  style?: LiquidStyle;
  /** z-index for the blob. Below the anchor's surface (e.g. the sidebar) it emerges from behind it */
  zIndex?: number;
  /** pop style: seconds the size change lags the position change (0 = single stage; larger approaches two stages) */
  sizeLag?: number;
  /** pop style: anchor and target looks. Color, border, shadow and blur change as the size grows */
  fromLook?: Look;
  toLook?: Look;
  /** If true, start open (for sending an already visible surface back to its anchor with a close animation) */
  initiallyOpen?: boolean;
  /** How much the blob is drawn over the anchor (0..1, GPU rendering only). While above 0, don't raise the anchor in front */
  over?: MotionValue<number>;
  /**
   * Keep drawing the blob as the real surface's frame after opening (menus, GPU rendering only).
   * Since it never swaps with the real background/border/shadow, spring overshoot can't misalign them. Follows target size changes
   */
  hold?: boolean;
}

export interface Look {
  background: string;
  border: string;
  shadow: string;
  blur: number;
}

const DEFAULT_FROM: Look = { background: "rgba(38, 38, 38, 1)", border: "rgba(255, 255, 255, 0)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
const DEFAULT_TO: Look = { background: "rgba(23, 23, 23, 0.85)", border: "rgba(255, 255, 255, 0.1)", shadow: "0px 16px 48px rgba(0, 0, 0, 0.55)", blur: 40 };

/** Corner radius in flight (px). Switches to the target's radius over the last 25% */
const FLIGHT_RADIUS = 16;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const LEAD = appleSpring({ duration: 0.3, bounce: 0.3 });
const TRAIL = appleSpring({ duration: 0.45, bounce: 0.2 });

/**
 * Separation animation. Show the real surface while `revealed` is true, and render `layer` somewhere.
 * `mounted` says whether the real surface should be in the DOM (it stays mounted while animating so it can be measured)
 */
export function useLiquidMorph(
  open: boolean,
  {
    anchor,
    target,
    radius,
    anchorRadius = 8,
    color = "#262626",
    style = "pop",
    zIndex = 60,
    sizeLag = 0.12,
    fromLook = DEFAULT_FROM,
    toLook = DEFAULT_TO,
    initiallyOpen = false,
    over,
    hold = false,
  }: Options,
) {
  // Follows Settings → Reduce motion as well as macOS (through MotionConfig)
  const reduced = !!useReducedMotionConfig();
  const [phase, setPhase] = useState<Phase>(initiallyOpen ? "open" : "closed");
  const L = useMotionValue(0);
  const T = useMotionValue(0);
  const R = useMotionValue(0);
  const B = useMotionValue(0);
  const rad = useMotionValue(0);
  const opacity = useMotionValue(0);
  const ghostOpacity = useMotionValue(0);
  const ghostScale = useMotionValue(1);
  /** Visual progress (0 = anchor, 1 = target) */
  const look = useMotionValue(initiallyOpen ? 1 : 0);
  const [ghost, setGhost] = useState<Edges | null>(null);
  // Liquid merging (pop style): the GPU merges anchor and blob into one shape with smin (liquid-gl.ts).
  // Without it, draw a DOM surface instead (no merging)
  const rawRef = useRef<Rect | null>(null);
  /** Hold-back amount (apply reads it to offset the blob) */
  const tension = useMotionValue(0);
  const blobOff = useRef<(() => void) | null>(null);
  const gl = useMemo(() => liquidGlSupported(), []);
  const running = useRef<{ stop(): void }[]>([]);
  const run = useRef(0);

  /** The anchor's own motion during this animation (pulled while joined, takes the impact on return) */
  const body = useRef<AnchorBody | null>(null);

  const stopAll = () => {
    running.current.forEach((c) => c.stop());
    running.current = [];
    blobOff.current?.();
    blobOff.current = null;
    body.current?.stop();
  };
  /** Drive mv 0 -> 1 with a soft-start spring (peels off slowly while connected, then accelerates) */
  const peel = (mv: MotionValue<number>) =>
    new Promise<void>((resolve) => {
      const sp = new PeelSpring(0.35, 0.3);
      sp.x = mv.get();
      let last = 0;
      let raf = 0;
      // Time comes from performance.now (same clock as motion), not the requestAnimationFrame argument
      const tick = () => {
        const now = performance.now();
        const dt = last ? Math.min(1 / 30, (now - last) / 1000) : 1 / 60;
        last = now;
        mv.set(sp.step(1, dt));
        if (sp.settled(1)) {
          mv.set(1);
          resolve();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      running.current.push({
        stop: () => {
          cancelAnimationFrame(raf);
          resolve();
        },
      });
    });
  const go = (mv: MotionValue<number>, v: number, t: object) => {
    const c = animate(mv, v, t);
    running.current.push(c);
    return c;
  };
  const set = (e: Edges) => {
    L.set(e.l);
    T.set(e.t);
    R.set(e.r);
    B.set(e.b);
    rad.set(e.radius);
  };
  /** Each edge uses either the leading (lead) or trailing (trail) spring */
  const moveEdges = (to: Edges, lead: object, trail: object) => {
    const cx = (L.get() + R.get()) / 2;
    const cy = (T.get() + B.get()) / 2;
    const tx = (to.l + to.r) / 2;
    const ty = (to.t + to.b) / 2;
    const right = tx >= cx;
    const down = ty >= cy;
    return Promise.all([
      go(R, to.r, right ? lead : trail),
      go(L, to.l, right ? trail : lead),
      go(B, to.b, down ? lead : trail),
      go(T, to.t, down ? trail : lead),
      go(rad, to.radius, trail),
    ]);
  };
  const moveAll = (to: Edges, t: object) => moveEdges(to, t, t);

  const play = useCallback(
    async (opening: boolean) => {
      const id = ++run.current;
      const alive = () => run.current === id;
      stopAll();
      const src = edgesOf(anchors.get(anchor), anchorRadius);
      // Wait until the target is rendered (it may not be in the DOM right after opening)
      for (let i = 0; i < 10 && !target.current; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (!alive()) return;
      }
      // Menus and such get positioned right after mounting. Wait for the position to settle before measuring
      if (opening) {
        let last = "";
        for (let i = 0; i < 8 && target.current; i++) {
          const b = target.current.getBoundingClientRect();
          const key = `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}`;
          if (key === last && b.width > 0) break;
          last = key;
          await new Promise((r) => requestAnimationFrame(r));
          if (!alive()) return;
        }
      }
      const dst = edgesOf(target.current, radius);
      if (reduced || !src || !dst) {
        setPhase(opening ? "open" : "closed");
        return;
      }
      setGhost(src);
      const from = opening ? src : dst;
      const to = opening ? dst : src;
      // If the direction reverses midway, continue from the current shape
      if (opacity.get() === 0) set(from);
      opacity.set(1);
      setPhase(opening ? "opening" : "closing");

      if (style === "pop") {
        // Between one and two stages: position moves first, size follows slightly later on a longer spring (reversed when closing)
        ghostOpacity.set(0);
        const a = { l: L.get(), t: T.get(), r: R.get(), b: B.get(), radius: rad.get() };
        const ac = { x: (a.l + a.r) / 2, y: (a.t + a.b) / 2, w: a.r - a.l, h: a.b - a.t };
        let bc = { x: (to.l + to.r) / 2, y: (to.t + to.b) / 2, w: to.r - to.l, h: to.b - to.t };
        // When opening, re-measure the target every frame (menus keep resizing for a few frames after mounting,
        // and sticking with the first measurement misaligns the real frame and the blob)
        let toLive = to;
        const track = () => {
          if (!opening) return;
          const b = target.current?.getBoundingClientRect();
          if (!b || b.width <= 0) return;
          toLive = { l: b.left, t: b.top, r: b.right, b: b.bottom, radius: to.radius };
          bc = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2, w: b.width, h: b.height };
        };
        const p = motionValueOf(0);
        const q = motionValueOf(0);
        // Liquid merging: anchor and blob become one shape via smin. When opening, hold the blob back slightly
        // while the neck connects them (adhesion) and spring it free once the neck breaks. k drops to 0 before full size so they always separate
        const anchorC = { x: (src.l + src.r) / 2, y: (src.t + src.b) / 2 };
        const kMax = mergeWidth(Math.min(src.r - src.l, src.b - src.t));
        const adh = new Adhesion(opening);
        const anchorBody = new AnchorBody(anchors.get(anchor));
        body.current = anchorBody;
        /** Unit vector from the anchor to the blob */
        const dirToBlob = (): Dir => {
          const raw = rawRef.current;
          if (!raw) return { x: 0, y: 0 };
          const dx = (raw.l + raw.r) / 2 - anchorC.x;
          const dy = (raw.t + raw.b) / 2 - anchorC.y;
          const d = Math.hypot(dx, dy) || 1;
          return { x: dx / d, y: dy / d };
        };
        adh.onSnap = () => anchorBody.release(dirToBlob());
        // Closing: the anchor takes the impact once, when the blob comes back into it. A blob that started apart
        // touches it; one that never left (a menu over its own row) arrives when its size is nearly back
        let absorbed = opening;
        let apart = false;
        let prev: { d: number; size: number } | null = null;
        let speed = 0;
        tension.set(0);
        const fillA = parseColor(fromLook.background);
        const lineA = parseColor(fromLook.border);
        if (gl) {
          blobOff.current = addBlob({
            frame: (dt) => {
              const raw = rawRef.current;
              if (!raw) return null;
              const el = anchors.get(anchor);
              const ab = el?.getBoundingClientRect();
              const a = ab ? { l: ab.left, t: ab.top, r: ab.right, b: ab.bottom } : src;
              const grown = Math.min(1, Math.max(0, q.get()));
              const sx = popScaleX.get();
              const sy = popScaleY.get();
              const cx = (L.get() + R.get()) / 2;
              const cy = (T.get() + B.get()) / 2;
              // When closing, widen the merge distance as it returns (gets sucked back in)
              const kBase = opening ? mergeAt(kMax, grown) : kMax * Math.min(1, Math.max(0, (grown - 0.25) / 0.5));
              const thick = Math.min(a.r - a.l, a.b - a.t);
              // Don't merge while overlapping (exact overlap bulges the whole shape, making it look larger than the anchor).
              // The adhesion follows where the blob really is; the drawing follows the fused shape below
              const kRaw = kBase * separation(Math.hypot(cx - (a.l + a.r) / 2, cy - (a.t + a.b) / 2), thick);
              const gap = rectGap(a, raw);
              const pull = adh.update(dt, gap, kRaw);
              if (opening) {
                tension.set(pull);
                // While joined, the anchor itself is drawn toward the blob as the neck stretches
                if (adh.connected && kMax > 0) anchorBody.pull(dirToBlob(), pull / (kMax * 0.8));
              } else if (!absorbed) {
                // How fast the blob is coming home: its center closing in, plus its size shrinking
                const d = Math.hypot((raw.l + raw.r) / 2 - anchorC.x, (raw.t + raw.b) / 2 - anchorC.y);
                const size = raw.r - raw.l + (raw.b - raw.t);
                if (prev && dt > 0) speed = Math.max(0, (prev.d - d) / dt) + Math.max(0, (prev.size - size) / dt) / 2;
                prev = { d, size };
                if (gap > 2) apart = true;
                if ((apart && gap <= 0.5) || (!apart && grown >= 0.85)) {
                  absorbed = true;
                  anchorBody.absorb(dirToBlob(), speed);
                }
              }
              const hw = ((R.get() - L.get()) * sx) / 2;
              const hh = ((B.get() - T.get()) * sy) / 2;
              const blob = { l: cx - hw, t: cy - hh, r: cx + hw, b: cy + hh, radius: rad.get() * Math.min(sx, sy) };
              // Fusion: next to the button the blob takes the button's own shape (it reads its live rect, so it follows
              // the button's tug and squash). Opening, it leaves from the button; closing, it becomes the button again,
              // so no edge of it ever shows around the button behind it
              const fuse = opening ? 1 - smoothstep(0, 0.3, grown) : smoothstep(0.6, 1, grown);
              const fused =
                fuse > 0
                  ? {
                      l: lerp(blob.l, a.l, fuse),
                      t: lerp(blob.t, a.t, fuse),
                      r: lerp(blob.r, a.r, fuse),
                      b: lerp(blob.b, a.b, fuse),
                      radius: lerp(blob.radius, anchorRadius, fuse),
                    }
                  : blob;
              // Merge width for what is drawn: from the fused shape, so a blob that has become the button doesn't bulge
              const k = kBase * separation(Math.hypot((fused.l + fused.r) / 2 - (a.l + a.r) / 2, (fused.t + fused.b) / 2 - (a.t + a.b) / 2), thick);
              return {
                a: { ...a, radius: anchorRadius },
                s: fused,
                k,
                fillA,
                fillS: parseColor(background.get()),
                lineA,
                lineS: parseColor(borderColor.get()),
                shadow: parseShadow(boxShadow.get()),
                opacity: opacity.get(),
                over: over?.get() ?? 0,
              };
            },
          });
        }
        const apply = () => {
          track();
          const pv = p.get();
          const qv = q.get();
          const cx = lerp(ac.x, bc.x, pv);
          const cy = lerp(ac.y, bc.y, pv);
          const w = Math.max(4, lerp(ac.w, bc.w, qv));
          const h = Math.max(4, lerp(ac.h, bc.h, qv));
          rawRef.current = { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
          const pull = tension.get();
          const dx = cx - anchorC.x;
          const dy = cy - anchorC.y;
          const dl = Math.hypot(dx, dy);
          const ox = dl > 1 ? (dx / dl) * pull : 0;
          const oy = dl > 1 ? (dy / dl) * pull : 0;
          L.set(cx - w / 2 - ox);
          R.set(cx + w / 2 - ox);
          T.set(cy - h / 2 - oy);
          B.set(cy + h / 2 - oy);
          const k = Math.min(1, Math.max(0, qv));
          // Corner radius: takes the flight radius at the start, holds it, and only switches to the target's radius near the end
          const travel = Math.min(1, Math.max(0, pv));
          const flight = FLIGHT_RADIUS;
          const r = travel < 0.75 ? lerp(a.radius, flight, smoothstep(0, 0.25, travel)) : lerp(flight, to.radius, smoothstep(0.75, 1, travel));
          rad.set(Math.min(r, Math.min(w, h) / 2));
          look.set(opening ? k : 1 - k);
        };
        const offP = p.on("change", apply);
        const offQ = q.on("change", apply);
        const offT = tension.on("change", apply);
        const posSpring = snappy;
        const sizeSpring = appleSpring({ duration: 0.42, bounce: 0.3 });
        await Promise.all([
          // Position while opening uses the soft-start spring (peels off slowly while merged)
          opening && gl ? peel(p) : go(p, 1, opening ? { ...posSpring } : { ...posSpring, delay: sizeLag }),
          go(q, 1, opening ? { ...sizeSpring, delay: sizeLag } : { ...snappy }),
        ]);
        offP();
        offQ();
        offT();
        if (opening && hold && gl && alive()) {
          // The blob becomes the frame: it keeps tracking the target after settling and is drawn until closed (replaced by another animation)
          setPhase("open");
          let raf = 0;
          const follow = () => {
            track();
            set({ ...toLive, radius: toLive.radius });
            raf = requestAnimationFrame(follow);
          };
          raf = requestAnimationFrame(follow);
          running.current.push({ stop: () => cancelAnimationFrame(raf) });
          return;
        }
        // From here the real surface appears in the same place (if reversed midway, don't overwrite the new animation's position)
        if (alive()) {
          track();
          set({ ...toLive, radius: rad.get() });
        }
      } else if (style === "morph") {
        if (!opening) ghostOpacity.set(0);
        await moveEdges(to, LEAD, TRAIL);
      } else if (style === "tear") {
        // Stretch toward the target while stuck to the anchor (the trailing edge stays put for now)
        ghostOpacity.set(1);
        ghostScale.set(1);
        const stretched = opening
          ? { ...src, r: Math.max(src.r, lerp(src.r, dst.l, 0.55)), b: lerp(src.b, (dst.t + dst.b) / 2, 0.25) }
          : { ...dst, l: Math.min(dst.l, lerp(dst.l, src.r, 0.55)), t: lerp(dst.t, (src.t + src.b) / 2, 0.25), b: lerp(dst.b, src.b, 0.4) };
        await Promise.all([go(R, stretched.r, interactive), go(B, stretched.b, interactive), go(L, stretched.l, interactive), go(T, stretched.t, interactive)]);
        if (!alive()) return;
        // Tear: the anchor side shrinks away and the body carries on into the target shape
        go(ghostScale, 0.6, smooth);
        go(ghostOpacity, 0, { duration: 0.14 });
        await moveEdges(to, LEAD, bouncy);
      } else {
        // droplet
        ghostOpacity.set(1);
        const a = opening ? src : dst;
        const off = drop(lerp((a.l + a.r) / 2, (to.l + to.r) / 2, 0.12), lerp((a.t + a.b) / 2, (to.t + to.b) / 2, 0.12));
        await moveAll(off, interactive);
        if (!alive()) return;
        go(ghostOpacity, 0, { duration: 0.12 });
        await moveAll(drop((to.l + to.r) / 2, (to.t + to.b) / 2), smooth);
        if (!alive()) return;
        await moveAll(to, bouncy);
      }
      if (!alive()) return;
      if (opening) {
        setPhase("open");
        await go(opacity, 0, { duration: 0.12 });
      } else {
        // Fused with the anchor and drawn over it: its color fades out on top of the button
        ghostOpacity.set(0);
        await go(opacity, 0, { duration: 0.22, ease: [0.25, 0.1, 0.25, 1] });
        if (alive()) setPhase("closed");
      }
      if (alive()) {
        blobOff.current?.();
        blobOff.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchor, anchorRadius, radius, reduced, style, sizeLag, gl],
  );

  useEffect(() => {
    if (open && (phase === "closed" || phase === "closing")) {
      setPhase("opening");
      // Render first so the target can be measured, then animate
      requestAnimationFrame(() => void play(true));
    } else if (!open && (phase === "open" || phase === "opening")) {
      void play(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => stopAll(), []);
  useEffect(() => () => blobOff.current?.(), []);

  const x = useTransform(L, (v) => v);
  const y = useTransform(T, (v) => v);
  const w = useTransform([L, R], ([l, r]: number[]) => Math.max(0, r - l));
  const h = useTransform([T, B], ([t, b]: number[]) => Math.max(0, b - t));
  // Only the droplet style stretches along its velocity
  const vx = useVelocity(L);
  const vy = useVelocity(T);
  const stretch = useTransform<number, string>([vx, vy], ([a, b]) => {
    if (style !== "droplet") return "none";
    const s = 1 + Math.min(Math.hypot(a, b) / 2600, 0.5);
    const angle = (Math.atan2(b, a) * 180) / Math.PI;
    return `rotate(${angle}deg) scale(${s}, ${1 / Math.sqrt(s)}) rotate(${-angle}deg)`;
  });

  const background = useTransform(look, [0, 1], [fromLook.background, toLook.background]);
  const borderColor = useTransform(look, [0, 1], [fromLook.border, toLook.border]);
  const boxShadow = useTransform(look, [0, 1], [fromLook.shadow, toLook.shadow]);
  const backdrop = useTransform(look, (v) => `blur(${lerp(fromLook.blur, toLook.blur, v)}px) saturate(${lerp(100, 150, v)}%)`);
  // pop: stretches horizontally and thins vertically with speed as it slips past the edge (back to normal at rest)
  const popScaleX = useTransform(vx, (v) => 1 + Math.min(Math.abs(v) / 9000, 0.18));
  const popScaleY = useTransform(popScaleX, (s) => 1 / Math.sqrt(s));

  const animating = phase === "opening" || phase === "closing";
  // look is the open amount (0 = anchor, 1 = target; goes 1 -> 0 when closing)
  const edgesRef = useMemo(() => ({ L, T, R, B, rad, look }), [L, T, R, B, rad, look]);
  if (style === "pop") {
    // With the GPU, draw the shape merged with the anchor on the liquid-gl canvas (no DOM surface).
    // Otherwise draw just a DOM surface with border and shadow (no merging)
    const surface =
      animating && !gl
        ? createPortal(
            <>
              <motion.div
                aria-hidden
                className="pointer-events-none fixed top-0 left-0 border"
                style={{
                  zIndex,
                  x,
                  y,
                  width: w,
                  height: h,
                  scaleX: popScaleX,
                  scaleY: popScaleY,
                  opacity,
                  borderRadius: rad,
                  background,
                  borderColor,
                  boxShadow,
                  backdropFilter: backdrop,
                  WebkitBackdropFilter: backdrop,
                }}
              />
            </>,
            document.body,
          )
        : null;
    return {
      revealed: phase === "open",
      mounted: phase !== "closed",
      /**
       * The blob remains as the frame after opening (stage keeps it registered). Not with reduced motion: no blob was
       * drawn, so the surface shows its own frame (holding on would hide it and clip it to a shape that never appears)
       */
      holding: hold && gl && !reduced && phase === "open",
      layer: surface,
      edges: edgesRef,
      /** Something is still moving after opening (currently unused; hook for stage's lingering) */
      settling: false,
    };
  }
  const layer = animating
    ? createPortal(
        <div aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex, filter: `url(#${GOO_ID})` }}>
          {ghost && (
            <motion.div
              className="absolute"
              style={{
                left: ghost.l,
                top: ghost.t,
                width: ghost.r - ghost.l,
                height: ghost.b - ghost.t,
                borderRadius: anchorRadius,
                background: color,
                opacity: ghostOpacity,
                scale: ghostScale,
              }}
            />
          )}
          <motion.div className="absolute top-0 left-0" style={{ x, y, width: w, height: h, opacity }}>
            <motion.div className="size-full" style={{ borderRadius: rad, background: color, transform: stretch }} />
          </motion.div>
        </div>,
        document.body,
      )
    : null;

  return { revealed: phase === "open", mounted: phase !== "closed", holding: false, layer, edges: edgesRef, settling: false };
}
