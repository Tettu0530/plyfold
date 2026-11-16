// 分離アニメーションの共通部品（.claude/skills/no-ai-slop-ui の 4. 動き）
//
// 押した場所（出発点）から別の面（行き先）が開くときの動き。形は上下左右の 4 つの端で表し、
// 端ごとに別のばねで動かす（先に伸びる端と、遅れてついてくる端を作るため）。型は 3 つ:
//   morph   : 出発点の形のまま、行き先側の端が先に伸び、反対側が遅れてついてきて収まる（Apple のメニューに近い）
//   tear    : 出発点にくっついたまま引き伸ばされ、限界でちぎれて、勢いで行き先の形まで飛ぶ
//   droplet : 丸い滴に縮んで離れ、移動してから広がる
//   pop     : 出発点の裏から滑り出て、そのまま 1 本のばねで行き先の形へ（標準。出発点の面より下に描く）
// 測定（tools/liquid-probe）では、Apple の変形は外枠が 1 本のばねで動く。どの型も段ごとに 1 本のばねで動かす
import { animate, motion, motionValue, useMotionValue, useReducedMotion, useTransform, useVelocity, type MotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { appleSpring, bouncy, interactive, smooth, snappy, springToCss } from "../motion";
import { addBlob, liquidGlSupported, parseColor, parseShadow } from "./liquid-gl";
import { Adhesion, mergeAt, mergeWidth, PeelSpring, separation } from "./sdf";

type Rect = { l: number; t: number; r: number; b: number };
const rectGap = (a: Rect, s: Rect) => Math.hypot(Math.max(0, s.l - a.r, a.l - s.r), Math.max(0, s.t - a.b, a.t - s.b));

export type LiquidStyle = "pop" | "morph" | "tear" | "droplet";

// ---- 出発点の登録（名前 → 要素）
// 開発中の部分的な差し替え（HMR）でこのファイルが 2 つ読み込まれても、登録簿は 1 つに保つ
const g = globalThis as { __plyfoldAnchors?: Map<string, HTMLElement> };
const anchors = (g.__plyfoldAnchors ??= new Map<string, HTMLElement>());

/** 分離の出発点にする要素を登録する ref を返す */
export function liquidAnchor(name: string) {
  return (el: HTMLElement | null) => {
    if (el) anchors.set(name, el);
    else anchors.delete(name);
  };
}

/** 登録した出発点の要素 */
export function liquidAnchorElement(name: string): HTMLElement | undefined {
  return anchors.get(name);
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

/** 切れた瞬間に、出発点を実体の向きへ少し引っぱってから、ばねで戻す */
function wobble(el: HTMLElement | undefined, dir: { x: number; y: number }) {
  if (!el?.animate) return;
  const { easing, ms } = springToCss({ duration: 0.45, bounce: 0.45 });
  el.animate(
    [
      { transform: `translate(${(dir.x * 3).toFixed(1)}px, ${(dir.y * 3).toFixed(1)}px) scale(${(1 + 0.05 * Math.abs(dir.x)).toFixed(3)}, ${(1 + 0.05 * Math.abs(dir.y)).toFixed(3)})` },
      { transform: "translate(0px, 0px) scale(1, 1)" },
    ],
    { duration: ms, easing, composite: "add" },
  );
}

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
  /** true なら「開いた状態」から始める（すでに表示中の面を、閉じる動きで出発点へ戻すとき） */
  initiallyOpen?: boolean;
  /** 出発点の上に実体を重ねる量（0〜1、GPU の描画だけ）。0 より大きいあいだ、出発点は手前に出さないこと */
  over?: MotionValue<number>;
  /**
   * 開いたあとも実体を消さず、本物の枠として描き続ける（メニュー。GPU の描画だけ）。
   * 本物の地・枠線・影と入れ替えないので、ばねの跳ね返りで枠と実体がずれない。行き先の大きさが変われば追う
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

/** 飛んでいるあいだの角の丸み（px）。行き先の丸みへは最後の 25% で変える */
const FLIGHT_RADIUS = 16;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const LEAD = appleSpring({ duration: 0.3, bounce: 0.3 });
const TRAIL = appleSpring({ duration: 0.45, bounce: 0.2 });

/**
 * 分離アニメーション。`revealed` が true のあいだ本物を見せ、`layer` をどこかに描く。
 * `mounted` は本物を DOM に置いておくべきか（動いているあいだも置いて大きさを測る）
 */
export function useLiquidMorph(open: boolean, { anchor, target, radius, anchorRadius = 8, color = "#262626", style = "pop", zIndex = 60, sizeLag = 0.12, fromLook = DEFAULT_FROM, toLook = DEFAULT_TO, initiallyOpen = false, over, hold = false }: Options) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(initiallyOpen ? "open" : "closed");
  const L = useMotionValue(0);
  const T = useMotionValue(0);
  const R = useMotionValue(0);
  const B = useMotionValue(0);
  const rad = useMotionValue(0);
  const opacity = useMotionValue(0);
  const ghostOpacity = useMotionValue(0);
  const ghostScale = useMotionValue(1);
  /** 見た目の進み具合（0 = 出発点、1 = 行き先） */
  const look = useMotionValue(initiallyOpen ? 1 : 0);
  const [ghost, setGhost] = useState<Edges | null>(null);
  // 液体の融合（pop の型）: GPU で出発点と実体を smin で 1 つの形にして描く（liquid-gl.ts）。
  // 使えなければ DOM の面で描く（融合はしない）
  const rawRef = useRef<Rect | null>(null);
  /** 引き留める量（apply がこれを読んで実体の位置をずらす） */
  const tension = useMotionValue(0);
  const blobOff = useRef<(() => void) | null>(null);
  const gl = useMemo(() => liquidGlSupported(), []);
  const running = useRef<{ stop(): void }[]>([]);
  const run = useRef(0);

  const stopAll = () => {
    running.current.forEach((c) => c.stop());
    running.current = [];
    blobOff.current?.();
    blobOff.current = null;
  };
  /** 出だしが柔らかいばねで mv を 0 → 1 へ（つながっているあいだはゆっくり剥がれ、離れてから加速する） */
  const peel = (mv: MotionValue<number>) =>
    new Promise<void>((resolve) => {
      const sp = new PeelSpring(0.35, 0.3);
      sp.x = mv.get();
      let last = 0;
      let raf = 0;
      // 時刻は performance.now（motion と同じ時計）。requestAnimationFrame の引数は使わない
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
      // メニューなどは、出た直後に位置が決まる。位置が落ち着くまで待ってから測る
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
      // 途中で向きが変わったときは、今の形から続ける
      if (opacity.get() === 0) set(from);
      opacity.set(1);
      setPhase(opening ? "opening" : "closing");

      if (style === "pop") {
        // 1 段階と 2 段階の中間: 位置は先に動き、大きさは少し遅れて長めのばねで広がる（閉じるときは逆）
        ghostOpacity.set(0);
        const a = { l: L.get(), t: T.get(), r: R.get(), b: B.get(), radius: rad.get() };
        const ac = { x: (a.l + a.r) / 2, y: (a.t + a.b) / 2, w: a.r - a.l, h: a.b - a.t };
        let bc = { x: (to.l + to.r) / 2, y: (to.t + to.b) / 2, w: to.r - to.l, h: to.b - to.t };
        // 開くときは、行き先を毎フレーム測り直して追う（メニューは出た後も数フレーム大きさが決まり続け、
        // 最初に測った大きさのままだと、本物の枠と実体がずれる）
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
        // 液体の融合: 出発点と実体を smin で 1 つの形にする。開くときは、首でつながっているあいだ
        // 実体を少し引き留め（粘り）、首が切れたらばねで放す。k は広がりきる前に 0 へ絞って、必ず別々にする
        const anchorC = { x: (src.l + src.r) / 2, y: (src.t + src.b) / 2 };
        const kMax = mergeWidth(Math.min(src.r - src.l, src.b - src.t));
        const adh = new Adhesion(opening);
        adh.onSnap = () => {
          const raw = rawRef.current;
          if (!raw) return;
          const dx = (raw.l + raw.r) / 2 - anchorC.x;
          const dy = (raw.t + raw.b) / 2 - anchorC.y;
          const d = Math.hypot(dx, dy) || 1;
          wobble(anchors.get(anchor), { x: dx / d, y: dy / d });
        };
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
              // 重なっているあいだは融合させない（ぴったり重なると全体がふくらみ、出発点より大きく見える）
              const sep = separation(Math.hypot(cx - (a.l + a.r) / 2, cy - (a.t + a.b) / 2), Math.min(a.r - a.l, a.b - a.t));
              // 閉じるときは、戻ってくるにつれてつながる幅を広げる（吸い込まれる）
              const k = (opening ? mergeAt(kMax, grown) : kMax * Math.min(1, Math.max(0, (grown - 0.25) / 0.5))) * sep;
              const pull = adh.update(dt, rectGap(a, raw), k);
              if (opening) tension.set(pull);
              const hw = ((R.get() - L.get()) * sx) / 2;
              const hh = ((B.get() - T.get()) * sy) / 2;
              return {
                a: { ...a, radius: anchorRadius },
                s: { l: cx - hw, t: cy - hh, r: cx + hw, b: cy + hh, radius: rad.get() * Math.min(sx, sy) },
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
          // 角の丸み: 出だしで飛ぶときの丸みになり、途中はそのまま、最後の方でだけ行き先の丸みへ変える
          const travel = Math.min(1, Math.max(0, pv));
          const flight = FLIGHT_RADIUS;
          const r =
            travel < 0.75
              ? lerp(a.radius, flight, smoothstep(0, 0.25, travel))
              : lerp(flight, to.radius, smoothstep(0.75, 1, travel));
          rad.set(Math.min(r, Math.min(w, h) / 2));
          look.set(opening ? k : 1 - k);
        };
        const offP = p.on("change", apply);
        const offQ = q.on("change", apply);
        const offT = tension.on("change", apply);
        const posSpring = snappy;
        const sizeSpring = appleSpring({ duration: 0.42, bounce: 0.3 });
        await Promise.all([
          // 開くときの位置は、出だしの柔らかいばね（融合しているあいだゆっくり剥がれる）
          opening && gl ? peel(p) : go(p, 1, opening ? { ...posSpring } : { ...posSpring, delay: sizeLag }),
          go(q, 1, opening ? { ...sizeSpring, delay: sizeLag } : { ...snappy }),
        ]);
        offP();
        offQ();
        offT();
        if (opening && hold && gl && alive()) {
          // 実体がそのまま枠になる: 止まった後も行き先を追い、閉じる（別の動きに替わる）まで描き続ける
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
        // ここからは本物の面が同じ場所に出る（途中で向きが変わったときは、新しい動きの位置を上書きしない）
        if (alive()) {
          track();
          set({ ...toLive, radius: rad.get() });
        }
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
      // 行き先を測れるよう、先に描いてから動かす
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
  // pop: 縁をすり抜けるときの速さで横に伸び、縦に細くなる（止まれば元の形）
  const popScaleX = useTransform(vx, (v) => 1 + Math.min(Math.abs(v) / 9000, 0.18));
  const popScaleY = useTransform(popScaleX, (s) => 1 / Math.sqrt(s));

  const animating = phase === "opening" || phase === "closing";
  // look は開き具合（0 = 出発点、1 = 行き先。閉じるときは 1 から 0 へ）
  const edgesRef = useMemo(() => ({ L, T, R, B, rad, look }), [L, T, R, B, rad, look]);
  if (style === "pop") {
    // GPU が使えるときは、出発点と融合した形を liquid-gl のキャンバスに描く（DOM の面は出さない）。
    // 使えなければ、枠線と影の付いた DOM の面だけを描く（融合はしない）
    const surface = animating && !gl
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
      /** 開いた後も実体が枠として残っている（stage は登録を外さない） */
      holding: hold && gl && phase === "open",
      layer: surface,
      edges: edgesRef,
      /** 開いた後も、まだ何かが動いている（今は使っていない。stage の lingering の受け口） */
      settling: false,
    };
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

  return { revealed: phase === "open", mounted: phase !== "closed", holding: false, layer, edges: edgesRef, settling: false };
}
