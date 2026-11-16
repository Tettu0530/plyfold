// 分離アニメーションの共通部品（.claude/skills/no-ai-slop-ui の 4. 動き）
//
// 押した場所（出発点）から別の面（行き先）が開くときの動き。形は上下左右の 4 つの端で表し、
// 端ごとに別のばねで動かす（先に伸びる端と、遅れてついてくる端を作るため）。型は 3 つ:
//   morph   : 出発点の形のまま、行き先側の端が先に伸び、反対側が遅れてついてきて収まる（Apple のメニューに近い）
//   tear    : 出発点にくっついたまま引き伸ばされ、限界でちぎれて、勢いで行き先の形まで飛ぶ
//   droplet : 丸い滴に縮んで離れ、移動してから広がる
//   pop     : 出発点の裏から滑り出て、そのまま 1 本のばねで行き先の形へ（標準。出発点の面より下に描く）
// 測定（tools/liquid-probe）では、Apple の変形は外枠が 1 本のばねで動く。どの型も段ごとに 1 本のばねで動かす
import { animate, motion, motionValue, useMotionValue, useReducedMotion, useTransform, useVelocity, type AnimationPlaybackControls, type MotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { appleSpring, bouncy, interactive, smooth, snappy } from "../motion";

export type LiquidStyle = "pop" | "morph" | "tear" | "droplet";

// ---- 出発点の登録（名前 → 要素）
const anchors = new Map<string, HTMLElement>();

/** 分離の出発点にする要素を登録する ref を返す */
export function liquidAnchor(name: string) {
  return (el: HTMLElement | null) => {
    if (el) anchors.set(name, el);
    else anchors.delete(name);
  };
}

const GOO_ID = "plyfold-goo";

/** goo フィルタの定義（アプリに 1 つ置く） */
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
const motionValueOf = (v: number) => motionValue(v);
const drop = (cx: number, cy: number, d = 30): Edges => ({ l: cx - d / 2, t: cy - d / 2, r: cx + d / 2, b: cy + d / 2, radius: d / 2 });

type Phase = "closed" | "opening" | "open" | "closing";

interface Options {
  /** 出発点の名前（liquidAnchor で登録したもの） */
  anchor: string;
  /** 行き先の要素（本物の面）。見えない状態でも大きさを測れるように描いておくこと */
  target: React.RefObject<HTMLElement | null>;
  radius: number;
  anchorRadius?: number;
  /** 実体の色（行き先の面に近い色） */
  color?: string;
  style?: LiquidStyle;
  /** 実体を描く重なり順。出発点の面（サイドバーなど）より小さくすると、その裏から出てくる */
  zIndex?: number;
  /** pop の型で、大きさの変化を位置の変化より遅らせる秒数（0 なら 1 段階、大きいほど 2 段階に近い） */
  sizeLag?: number;
  /** pop の型で、出発点と行き先の見た目。大きさの広がりに合わせて色・枠線・影・ぼかしが変わる */
  fromLook?: Look;
  toLook?: Look;
}

export interface Look {
  background: string;
  border: string;
  shadow: string;
  blur: number;
}

const DEFAULT_FROM: Look = { background: "rgba(38, 38, 38, 1)", border: "rgba(255, 255, 255, 0)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
const DEFAULT_TO: Look = { background: "rgba(23, 23, 23, 0.85)", border: "rgba(255, 255, 255, 0.1)", shadow: "0px 16px 48px rgba(0, 0, 0, 0.55)", blur: 40 };

const LEAD = appleSpring({ duration: 0.3, bounce: 0.3 });
const TRAIL = appleSpring({ duration: 0.45, bounce: 0.2 });

/**
 * 分離アニメーション。`revealed` が true のあいだ本物を見せ、`layer` をどこかに描く。
 * `mounted` は本物を DOM に置いておくべきか（動いているあいだも置いて大きさを測る）
 */
export function useLiquidMorph(open: boolean, { anchor, target, radius, anchorRadius = 8, color = "#262626", style = "pop", zIndex = 60, sizeLag = 0.08, fromLook = DEFAULT_FROM, toLook = DEFAULT_TO }: Options) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("closed");
  const L = useMotionValue(0);
  const T = useMotionValue(0);
  const R = useMotionValue(0);
  const B = useMotionValue(0);
  const rad = useMotionValue(0);
  const opacity = useMotionValue(0);
  const ghostOpacity = useMotionValue(0);
  const ghostScale = useMotionValue(1);
  /** 見た目の進み具合（0 = 出発点、1 = 行き先） */
  const look = useMotionValue(0);
  const [ghost, setGhost] = useState<Edges | null>(null);
  const running = useRef<AnimationPlaybackControls[]>([]);
  const run = useRef(0);

  const stopAll = () => {
    running.current.forEach((c) => c.stop());
    running.current = [];
  };
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
  /** 端ごとに、先に伸びる側（lead）と遅れる側（trail）のばねを使い分ける */
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
      // 行き先が描かれるまで待つ（開いた直後はまだ DOM にないことがある）
      for (let i = 0; i < 10 && !target.current; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (!alive()) return;
      }
      const dst = edgesOf(target.current, radius);
      if (reduced || !src || !dst) {
        setPhase(opening ? "open" : "closed");
        return;
      }
      setGhost(src);
      const from = opening ? src : dst;
      const to = opening ? dst : src;
      // 途中で向きが変わったときは、今の形から続ける
      if (opacity.get() === 0) set(from);
      opacity.set(1);
      setPhase(opening ? "opening" : "closing");

      if (style === "pop") {
        // 1 段階と 2 段階の中間: 位置は先に動き、大きさは少し遅れて長めのばねで広がる（閉じるときは逆）
        ghostOpacity.set(0);
        const a = { l: L.get(), t: T.get(), r: R.get(), b: B.get(), radius: rad.get() };
        const ac = { x: (a.l + a.r) / 2, y: (a.t + a.b) / 2, w: a.r - a.l, h: a.b - a.t };
        const bc = { x: (to.l + to.r) / 2, y: (to.t + to.b) / 2, w: to.r - to.l, h: to.b - to.t };
        const p = motionValueOf(0);
        const q = motionValueOf(0);
        const apply = () => {
          const pv = p.get();
          const qv = q.get();
          const cx = lerp(ac.x, bc.x, pv);
          const cy = lerp(ac.y, bc.y, pv);
          const w = Math.max(4, lerp(ac.w, bc.w, qv));
          const h = Math.max(4, lerp(ac.h, bc.h, qv));
          L.set(cx - w / 2);
          R.set(cx + w / 2);
          T.set(cy - h / 2);
          B.set(cy + h / 2);
          const k = Math.min(1, Math.max(0, qv));
          rad.set(lerp(a.radius, to.radius, k));
          look.set(opening ? k : 1 - k);
        };
        const offP = p.on("change", apply);
        const offQ = q.on("change", apply);
        const posSpring = snappy;
        const sizeSpring = appleSpring({ duration: 0.42, bounce: 0.3 });
        await Promise.all([
          go(p, 1, opening ? { ...posSpring } : { ...posSpring, delay: sizeLag }),
          go(q, 1, opening ? { ...sizeSpring, delay: sizeLag } : { ...snappy }),
        ]);
        offP();
        offQ();
      } else if (style === "morph") {
        if (!opening) ghostOpacity.set(0);
        await moveEdges(to, LEAD, TRAIL);
      } else if (style === "tear") {
        // 出発点にくっついたまま、行き先の方へ引き伸ばす（離れる側の端はまだ動かさない）
        ghostOpacity.set(1);
        ghostScale.set(1);
        const stretched = opening
          ? { ...src, r: Math.max(src.r, lerp(src.r, dst.l, 0.55)), b: lerp(src.b, (dst.t + dst.b) / 2, 0.25) }
          : { ...dst, l: Math.min(dst.l, lerp(dst.l, src.r, 0.55)), t: lerp(dst.t, (src.t + src.b) / 2, 0.25), b: lerp(dst.b, src.b, 0.4) };
        await Promise.all([go(R, stretched.r, interactive), go(B, stretched.b, interactive), go(L, stretched.l, interactive), go(T, stretched.t, interactive)]);
        if (!alive()) return;
        // ちぎれる: 出発点側が縮んで離れ、本体は勢いで行き先の形へ
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
        // 出発点に融合して消える
        ghostOpacity.set(0);
        await go(opacity, 0, { duration: 0.12 });
        if (alive()) setPhase("closed");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchor, anchorRadius, radius, reduced, style, sizeLag],
  );

  useEffect(() => {
    if (open && (phase === "closed" || phase === "closing")) {
      setPhase("opening");
      // 行き先を測れるよう、先に描いてから動かす
      requestAnimationFrame(() => void play(true));
    } else if (!open && (phase === "open" || phase === "opening")) {
      void play(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => stopAll(), []);

  const x = useTransform(L, (v) => v);
  const y = useTransform(T, (v) => v);
  const w = useTransform([L, R], ([l, r]: number[]) => Math.max(0, r - l));
  const h = useTransform([T, B], ([t, b]: number[]) => Math.max(0, b - t));
  // 水滴の型だけ、速さの向きに伸ばす
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

  const animating = phase === "opening" || phase === "closing";
  if (style === "pop") {
    // 枠線と影を見せたいので goo フィルタは掛けない（裏から出るので糸も要らない）
    const surface = animating
      ? createPortal(
          <motion.div
            aria-hidden
            className="pointer-events-none fixed top-0 left-0 border"
            style={{
              zIndex,
              x,
              y,
              width: w,
              height: h,
              opacity,
              borderRadius: rad,
              background,
              borderColor,
              boxShadow,
              backdropFilter: backdrop,
              WebkitBackdropFilter: backdrop,
            }}
          />,
          document.body,
        )
      : null;
    return { revealed: phase === "open", mounted: phase !== "closed", layer: surface };
  }
  const layer = animating
    ? createPortal(
        <div aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex, filter: `url(#${GOO_ID})` }}>
          {ghost && (
            <motion.div
              className="absolute"
              style={{ left: ghost.l, top: ghost.t, width: ghost.r - ghost.l, height: ghost.b - ghost.t, borderRadius: anchorRadius, background: color, opacity: ghostOpacity, scale: ghostScale }}
            />
          )}
          <motion.div className="absolute top-0 left-0" style={{ x, y, width: w, height: h, opacity }}>
            <motion.div className="size-full" style={{ borderRadius: rad, background: color, transform: stretch }} />
          </motion.div>
        </div>,
        document.body,
      )
    : null;

  return { revealed: phase === "open", mounted: phase !== "closed", layer };
}
