// Liquid merging with signed distance fields (SDF), the same idea as Liquid Glass: combining each shape's field with a smooth minimum (smin)
// makes nearby edges pull toward each other, connect with a neck when closer, and pinch off when they move apart.
//
//   - Rounded box distance field: iq's sdRoundBox
//   - Merging: iq's quadratic smin. k is how far apart shapes can be and still connect (like spacing).
//     Gaps under k/2 connect, gaps under k pull the edges together (matches measured GlassEffectContainer spacing)
//   - Color: blend the two shapes' colors by the smin mix factor m
//
// The same math as the GPU renderer (the liquid-gl.ts shader), kept in JS for checks (tests and frame-by-frame images). No dependencies

export interface Box {
  /** Center and half width/height (px) */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  /** Corner radius (px) */
  r: number;
}

export function boxOf(l: number, t: number, r: number, b: number, radius: number): Box {
  const hw = Math.max(0, (r - l) / 2);
  const hh = Math.max(0, (b - t) / 2);
  return { cx: (l + r) / 2, cy: (t + b) / 2, hw, hh, r: Math.max(0, Math.min(radius, hw, hh)) };
}

/** Signed distance to a rounded box (negative inside) */
export function sdBox(x: number, y: number, b: Box): number {
  const qx = Math.abs(x - b.cx) - b.hw + b.r;
  const qy = Math.abs(y - b.cy) - b.hh + b.r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - b.r;
}

/** Quadratic smooth minimum. m is b's share (0 = only a, 1 = only b) */
export function smin(a: number, b: number, k: number): { d: number; m: number } {
  if (k <= 0) return a < b ? { d: a, m: 0 } : { d: b, m: 1 };
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  const d = Math.min(a, b) - h * h * k * 0.25;
  const m = a < b ? 0.5 * h * h : 1 - 0.5 * h * h;
  return { d, m };
}

/** Derive the merge distance k from the anchor's thickness (thicker anchors connect from farther away) */
export function mergeWidth(anchorThickness: number): number {
  // Pad the thickness so a neck is visible even for thin buttons (24-28px)
  return Math.max(40, Math.min(72, anchorThickness * 1.2 + 16));
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Scale k down by overlap: smin bulges two exactly overlapping shapes by k/4 (producing a lump larger than
 * the anchor at the start and end). 0 while the centers coincide, 1 once they're one anchor thickness apart
 */
export function separation(centerDist: number, anchorThickness: number): number {
  return smoothstep(0, Math.max(1, anchorThickness), centerDist);
}

/**
 * k during the animation. Tapers to 0 before full size so the shapes always end up separate
 * (even when the target sits right next to the anchor, they don't stay stuck). grown is the size progress
 */
export function mergeAt(k: number, grown: number): number {
  return k * (1 - smoothstep(0.45, 0.9, grown));
}

// ---- Adhesion: while connected (a neck exists), hold the blob back toward the anchor; release it on a spring once it breaks.
// Even in fast motion the neck visibly thins over a few frames and pinches off

class Spring {
  x = 0;
  v = 0;
  private k: number;
  private c: number;
  constructor(duration: number, bounce: number) {
    this.k = ((2 * Math.PI) / duration) ** 2;
    this.c = (4 * Math.PI * (1 - bounce)) / duration;
  }
  step(target: number, dt: number) {
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Adhesion strength: hold back by this fraction of the gap, capped at k × CAP */
const HOLD = 0.6;
const CAP = 0.8;

export class Adhesion {
  /** Connected by a neck */
  connected: boolean;
  /** Hold-back amount (px; negative means released and springing forward) */
  pull = 0;
  private release = new Spring(0.45, 0.4);
  /** Called at the moment of separation */
  onSnap?: () => void;
  constructor(connected: boolean) {
    this.connected = connected;
  }
  /** raw: gap before holding back, k: current merge distance */
  update(dt: number, raw: number, k: number): number {
    if (this.connected) {
      const hold = Math.min(raw * HOLD, k * CAP);
      // The neck breaks once the on-screen gap exceeds k/2 (a property of quadratic smin)
      if (raw - hold >= k / 2 || k <= 0.5) {
        this.connected = false;
        this.release.x = hold;
        this.release.v = 0;
        this.onSnap?.();
      } else {
        this.pull = hold;
        return this.pull;
      }
    }
    this.pull = this.release.step(0, dt);
    return this.pull;
  }
}

/**
 * Soft-start spring: stiffness starts at FROM times normal and ramps up over RAMP seconds (damping tracks the square root of stiffness).
 * Peels off slowly while connected and accelerates once free. The final oscillation matches the original spring
 */
export class PeelSpring {
  x = 0;
  v = 0;
  t = 0;
  private k: number;
  private c: number;
  private from: number;
  private ramp: number;
  constructor(duration: number, bounce: number, from = 0.18, ramp = 0.16) {
    this.k = ((2 * Math.PI) / duration) ** 2;
    this.c = (4 * Math.PI * (1 - bounce)) / duration;
    this.from = from;
    this.ramp = ramp;
  }
  step(target: number, dt: number) {
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.t += h;
      const r = Math.min(1, this.t / this.ramp);
      const s = this.from + (1 - this.from) * r * r * (3 - 2 * r);
      this.v += (-this.k * s * (this.x - target) - this.c * Math.sqrt(s) * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  settled(target: number) {
    return this.t > this.ramp && Math.abs(this.x - target) < 0.001 && Math.abs(this.v) < 0.01;
  }
}
