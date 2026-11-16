// Apple の動きの再現（.claude/skills/no-ai-slop-ui の 4. 動き）
//
// SwiftUI のばねは「duration（体感の長さ）」と「bounce（跳ね返り）」で表す。
// WWDC23「Animate with springs」で公開されている換算（質量 1）:
//   stiffness = (2π / duration)²
//   damping   = 4π(1 − bounce) / duration        （bounce ≥ 0）
//   damping   = 4π / (duration × (1 + bounce))    （bounce < 0、過減衰）
// これを Motion に硬さ・減衰として直接渡すので、SwiftUI と同じ式のばねになる。
import type { Transition } from "motion/react";

export interface SpringParams {
  duration: number;
  bounce: number;
}

export function springConstants({ duration, bounce }: SpringParams) {
  const stiffness = (2 * Math.PI / duration) ** 2;
  const damping = bounce >= 0 ? (4 * Math.PI * (1 - bounce)) / duration : (4 * Math.PI) / (duration * (1 + bounce));
  return { stiffness, damping, mass: 1 };
}

export function appleSpring(p: SpringParams, velocity?: number): Transition {
  return { type: "spring", ...springConstants(p), ...(velocity !== undefined ? { velocity } : {}) };
}

// SwiftUI の既定のばね
export const SMOOTH: SpringParams = { duration: 0.5, bounce: 0 };
export const SNAPPY: SpringParams = { duration: 0.5, bounce: 0.15 };
export const BOUNCY: SpringParams = { duration: 0.5, bounce: 0.3 };
/** 指に追従しているあいだ（SwiftUI の interactiveSpring: response 0.15、dampingFraction 0.86） */
export const INTERACTIVE: SpringParams = { duration: 0.15, bounce: 0.14 };

/** 画面やペインの移動、出現と消滅 */
export const smooth = appleSpring(SMOOTH);
/** 切り替えの印、スイッチ、矢印の回転 */
export const snappy = appleSpring(SNAPPY);
/** 小さく目を引くもの（権限確認の滴、通知） */
export const bouncy = appleSpring(BOUNCY);
export const interactive = appleSpring(INTERACTIVE);

/** 互換のための別名（切り替えの印など） */
export const spring = snappy;

/** ばねの位置 x(t)（0 → 1）を解析的に解く */
export function springPosition({ stiffness, damping, mass }: { stiffness: number; damping: number; mass: number }, t: number): number {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/** CSS の transition に使う linear() の曲線と、落ち着くまでの時間 */
export function springToCss(p: SpringParams, samples = 48): { easing: string; ms: number } {
  const k = springConstants(p);
  let settle = p.duration;
  // 1/1000 以内に収まり続ける時刻を探す（上限 3 秒）
  for (let t = 0; t < 3; t += 0.005) {
    let ok = true;
    for (let u = t; u < t + 0.2; u += 0.02) if (Math.abs(1 - springPosition(k, u)) > 0.001) ok = false;
    if (ok) {
      settle = Math.max(t, 0.05);
      break;
    }
  }
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (settle * i) / samples;
    pts.push(i === samples ? "1" : springPosition(k, t).toFixed(4));
  }
  return { easing: `linear(${pts.join(", ")})`, ms: Math.round(settle * 1000) };
}

/** CSS 変数 --ease-NAME と --dur-NAME を配る（shadcn の部品の CSS のトランジション用） */
export function installCssSprings(root: HTMLElement = document.documentElement) {
  for (const [name, p] of [["smooth", SMOOTH], ["snappy", SNAPPY], ["bouncy", BOUNCY]] as const) {
    const { easing, ms } = springToCss(p);
    root.style.setProperty(`--ease-${name}`, easing);
    root.style.setProperty(`--dur-${name}`, `${ms}ms`);
  }
}

/** 押しているあいだ少し膨らむ（Liquid Glass のボタン）。離すとばねで戻る */
export const press = {
  whileTap: { scale: 1.06 },
  transition: interactive,
};

/** 権限確認の滴: 状態の点の方から落ちて広がる */
export const dropIn = {
  initial: { opacity: 0, scale: 0.05, y: -28 },
  animate: { opacity: 1, scale: 1, y: 0, transition: bouncy },
  exit: { opacity: 0, scale: 0.05, y: -28, transition: smooth },
};

/**
 * 指を離した後の行き先を、Apple の慣性（UIScrollView の減速率 0.998/ms）で予測する。
 * WWDC18「Designing Fluid Interfaces」の project(initialVelocity:decelerationRate:) と同じ式
 */
export function project(position: number, velocityPerSec: number, decelerationRate = 0.998): number {
  const vPerMs = velocityPerSec / 1000;
  return position + (vPerMs * decelerationRate) / (1 - decelerationRate);
}

/** 端を越えたときのゴムの伸び（UIScrollView と同じ式。c = 0.55） */
export function rubberBand(overshoot: number, dimension: number, c = 0.55): number {
  const sign = Math.sign(overshoot);
  const x = Math.abs(overshoot);
  return sign * (1 - 1 / ((x * c) / dimension + 1)) * dimension;
}
