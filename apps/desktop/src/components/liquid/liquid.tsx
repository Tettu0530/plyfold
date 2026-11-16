// 分離アニメーションの共通部品（.claude/skills/no-ai-slop-ui の 4. 動き）
//
// 押した場所から実体が水滴のように分かれ、速さに応じて伸びながら移動し、行き先で面に広がる。
// 閉じるときは逆に縮んで戻り、元の場所に融合する。
//   1. 分離: 出発点と同じ形 → 丸い滴に縮みながら離れる（goo フィルタで糸を引いてちぎれる）
//   2. 移動: 行き先の中心へ。速さの向きに伸びる（squash & stretch は移動中だけ）
//   3. 展開: 行き先の大きさと角の丸みへ広がる。広がりきったら本物を見せる
import { animate, motion, useMotionValue, useReducedMotion, useTransform, useVelocity, type AnimationPlaybackControls, type MotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { bouncy, interactive, smooth } from "../motion";

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
          <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" />
        </filter>
      </defs>
    </svg>
  );
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

const DROP = 30;

function boxOf(el: Element | null | undefined, radius: number): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, r: radius };
}

type Phase = "closed" | "opening" | "open" | "closing";

interface Options {
  /** 出発点の名前（liquidAnchor で登録したもの） */
  anchor: string;
  /** 行き先の要素（本物の面）。見えない状態でも大きさを測れるように描いておくこと */
  target: React.RefObject<HTMLElement | null>;
  /** 行き先の角の丸み（px） */
  radius: number;
  /** 出発点の角の丸み（px） */
  anchorRadius?: number;
  /** 滴の色（行き先の面に近い色） */
  color?: string;
}

/**
 * 分離アニメーション。戻り値の `revealed` が true のあいだ本物を見せ、`layer` をどこかに描く。
 * `mounted` は本物を DOM に置いておくべきか（動いているあいだも置いて大きさを測る）
 */
export function useLiquidMorph(open: boolean, { anchor, target, radius, anchorRadius = 8, color = "#262626" }: Options) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("closed");
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const w = useMotionValue(0);
  const h = useMotionValue(0);
  const r = useMotionValue(0);
  const blobOpacity = useMotionValue(0);
  const ghost = { x: useMotionValue(0), y: useMotionValue(0), w: useMotionValue(0), h: useMotionValue(0), o: useMotionValue(0) };
  const running = useRef<AnimationPlaybackControls[]>([]);
  const run = useRef(0);

  const stopAll = () => {
    running.current.forEach((c) => c.stop());
    running.current = [];
  };
  const to = (mv: MotionValue<number>, v: number, t: object) => {
    const c = animate(mv, v, t);
    running.current.push(c);
    return c;
  };
  const setBox = (b: Box) => {
    x.set(b.x);
    y.set(b.y);
    w.set(b.w);
    h.set(b.h);
    r.set(b.r);
  };
  const moveBox = (b: Box, t: object) => Promise.all([to(x, b.x, t), to(y, b.y, t), to(w, b.w, t), to(h, b.h, t), to(r, b.r, t)]);
  const dropAt = (cx: number, cy: number): Box => ({ x: cx - DROP / 2, y: cy - DROP / 2, w: DROP, h: DROP, r: DROP / 2 });

  const play = useCallback(
    async (opening: boolean) => {
      const id = ++run.current;
      const alive = () => run.current === id;
      stopAll();
      const src = boxOf(anchors.get(anchor), anchorRadius);
      const dst = boxOf(target.current, radius);
      if (reduced || !src || !dst) {
        setPhase(opening ? "open" : "closed");
        return;
      }
      // 出発点のすぐ右に滴が離れる位置
      const detached = dropAt(src.x + src.w / 2 + Math.min(40, src.w / 2), src.y + src.h / 2);
      const arrived = dropAt(dst.x + dst.w / 2, dst.y + Math.min(dst.h / 2, 60));
      ghost.x.set(src.x);
      ghost.y.set(src.y);
      ghost.w.set(src.w);
      ghost.h.set(src.h);

      if (opening) {
        setPhase("opening");
        // 動いている途中で開き直したときは、今の位置から続ける
        if (blobOpacity.get() === 0) {
          setBox(src);
          ghost.o.set(1);
        }
        blobOpacity.set(1);
        // 1. 分離: 丸い滴に縮みながら離れる。元の場所は少し遅れて消える（糸を引いてちぎれる）
        await moveBox(detached, interactive);
        if (!alive()) return;
        to(ghost.o, 0, { duration: 0.12 });
        // 2. 移動
        await moveBox(arrived, smooth);
        if (!alive()) return;
        // 3. 展開
        await moveBox(dst, bouncy);
        if (!alive()) return;
        setPhase("open");
        await to(blobOpacity, 0, { duration: 0.12 });
      } else {
        setPhase("closing");
        setBox(dst);
        blobOpacity.set(1);
        await moveBox(arrived, smooth);
        if (!alive()) return;
        await moveBox(detached, smooth);
        if (!alive()) return;
        // 元の場所に融合する
        to(ghost.o, 1, { duration: 0.08 });
        await moveBox(src, interactive);
        if (!alive()) return;
        await Promise.all([to(blobOpacity, 0, { duration: 0.12 }), to(ghost.o, 0, { duration: 0.12 })]);
        if (alive()) setPhase("closed");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchor, anchorRadius, radius, reduced],
  );

  useEffect(() => {
    if (open && (phase === "closed" || phase === "closing")) {
      // 行き先を測れるよう、先に描いてから動かす
      setPhase("opening");
      requestAnimationFrame(() => void play(true));
    } else if (!open && (phase === "open" || phase === "opening")) {
      void play(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => stopAll(), []);

  // 速さの向きに伸ばす（止まっていれば元の形）
  const vx = useVelocity(x);
  const vy = useVelocity(y);
  const stretch = useTransform<number, string>([vx, vy], ([a, b]) => {
    const speed = Math.hypot(a, b);
    const s = 1 + Math.min(speed / 2600, 0.55);
    const angle = (Math.atan2(b, a) * 180) / Math.PI;
    return `rotate(${angle}deg) scale(${s}, ${1 / Math.sqrt(s)}) rotate(${-angle}deg)`;
  });

  const animating = phase === "opening" || phase === "closing";
  const layer = animating
    ? createPortal(
        <div aria-hidden className="pointer-events-none fixed inset-0 z-[60]" style={{ filter: `url(#${GOO_ID})` }}>
          <motion.div className="absolute top-0 left-0" style={{ x: ghost.x, y: ghost.y, width: ghost.w, height: ghost.h, opacity: ghost.o, borderRadius: anchorRadius, background: color }} />
          <motion.div className="absolute top-0 left-0" style={{ x, y, width: w, height: h, opacity: blobOpacity }}>
            <motion.div className="size-full" style={{ borderRadius: r, background: color, transform: stretch }} />
          </motion.div>
        </div>,
        document.body,
      )
    : null;

  return { revealed: phase === "open", mounted: phase !== "closed", layer };
}
