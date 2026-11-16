// 分離アニメーションの規格の入口（.claude/skills/no-ai-slop-ui の 4. 動き）
//
//   liquidOpen("pane-0", { anchor: "session:<id>", target: () => 要素 })   … 出発点の裏から飛び出して、行き先に広がる
//   liquidClose("pane-0")                                                … 行き先から縮んで、出発点の裏へ戻る
//   liquidCloseFrom("pane-0", { anchor, target })                        … 今表示中の面を、閉じる動きで出発点へ戻す
//   useLiquidRevealed("pane-0")                                          … 本物を見せてよいか（動いているあいだは false）
//
// 実体の描画は、アプリに 1 つ置く <LiquidStage /> がまとめて行う。
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
  /** 実体の重なり順。出発点（57）より下、サイドバーの地より上の 55 */
  zIndex?: number;
  /** 動き出すまでの待ち（ms）。待つあいだも行き先の中身は隠したまま */
  delay?: number;
  /** 動きが終わったとき（閉じる動きなら、行き先をここで片付ける） */
  onDone?: () => void;
  /**
   * 行き先が出発点を覆う大きさ（全面の画面）のとき。出発点を手前に出すのは、
   * 開くときは出だしだけ、閉じるときは戻ってくる終わりだけにする（広がった実体の上にボタンが残らない）
   */
  cover?: boolean;
  /**
   * メニューのように、行き先が出発点に重なって開くとき。出だしは出発点の裏から出て、
   * 開いている途中（開き具合 0.2〜0.5）から実体を出発点の上に乗せる（閉じるときは逆に、途中で裏へ戻る）
   */
  rise?: boolean;
  fromLook?: Look;
  toLook?: Look;
}

interface Job extends LiquidJobOptions {
  id: string;
  open: boolean;
  initiallyOpen: boolean;
  /** 同じ id で開き直したときに作り直すための番号 */
  nonce: number;
  /** cover / rise のとき、いま出発点を実体の下に下げているか */
  lowered?: boolean;
  /** 開ききって本物を見せているが、液架橋の尾がまだ戻りきっていない */
  lingering?: boolean;
}

interface StageState {
  jobs: Record<string, Job>;
  revealed: Record<string, boolean>;
}

// HMR でこのファイルが 2 つ読み込まれても、登録先は 1 つに保つ
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

/** 今表示中の面を、閉じる動きで出発点へ戻す（liquidOpen で開いていない面にも使える） */
export function liquidCloseFrom(id: string, opts: LiquidJobOptions) {
  useStage.setState((s) => ({
    // 開いた状態から始めるので、cover / rise の出発点は最初から実体の下
    jobs: { ...s.jobs, [id]: { ...opts, id, open: false, initiallyOpen: true, nonce: ++nonce, lowered: !!(opts.cover || opts.rise) } },
    revealed: { ...s.revealed, [id]: false },
  }));
}

/** id の面を見せてよいか。動きが登録されていなければ true */
export function useLiquidRevealed(id: string): boolean {
  return useStage((s) => (s.jobs[id] ? !!s.revealed[id] : true));
}

/** 何かの分離アニメーションが動いているか（サイドバーを実体より手前に出すため） */
export function useLiquidBusy(): boolean {
  return useStage((s) => Object.keys(s.jobs).length > 0);
}

/** 分離アニメーションの出発点のうち、いま実体より手前に出すものの名前（z-[57] を付ける） */
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

/** 分離アニメーションが動いている出発点の名前（下げているものも含む。選択中の色で残すため） */
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

/** id の分離アニメーションが動いているか */
export function useLiquidActive(id: string): boolean {
  return useStage((s) => !!s.jobs[id] && !s.jobs[id].lingering);
}

/**
 * 全面の画面用: 動いているあいだ、画面を実体の形で切り抜き、広がるのに合わせてフェードで見せる
 * （閉じるときは縮むのに合わせて薄れる）。広がりきるのを待たずに中身が出てくる
 */
export function useLiquidClip(id: string, ref: React.RefObject<HTMLElement | null>) {
  const active = useLiquidActive(id);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    // 行き先は開いた直後にはまだないことがある（メニューなど）。毎フレーム引き直す。
    // 触る前の値を覚えておき、終わったら戻す（React が style で付けた値を消さない）
    let el: HTMLElement | null = null;
    const KEYS = ["clipPath", "opacity", "transition", "animation", "background", "borderColor", "boxShadow", "backdropFilter"] as const;
    let saved: Partial<Record<(typeof KEYS)[number], string>> | null = null;
    const tick = () => {
      el = ref.current ?? el;
      if (el && !saved) {
        saved = Object.fromEntries(KEYS.map((k) => [k, el!.style[k]]));
        // 動いているあいだの「体」は液体の実体だけにする（本物の地・枠線・影を消す）。
        // 本物と実体が 2 つあると、ばねの跳ね返りで大きさがずれ、あいだに隙間が見えるため
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
        // 面積の割合で見せる（3 割から 8 割まで広がるあいだにフェード）。
        // 出発点が行き先と同じくらい大きい（右クリックの行など）と最初から面積が足りるので、開き具合でも抑える
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

/** Radix の既定のフェード・拡大を必ず止める（クラスでは打ち消せないので、インラインで）。
 * アニメーションが無いと、Radix は閉じたときに中身をすぐ外す（元のフェードで残らない） */
const NO_ANIMATION: React.CSSProperties = { animation: "none" };

/**
 * 小さなメニュー（Select / Popover）用。出発点のチップから飛び出して広がり、閉じると縮んで戻る。
 * Radix は閉じると中身をすぐ消すので、閉じる動きは直前の大きさから縮める。
 * 使い方: `const m = useLiquidMenu(id, anchorName)` → チップに `ref={liquidAnchor(anchorName)}`、
 * Root に `onOpenChange={m.onOpenChange}`、Content に `ref={m.ref}`・`style={m.style}`・z-[58]
 */
export function useLiquidMenu(id: string, anchor: string) {
  const ref = useRef<HTMLElement | null>(null);
  // 動いているあいだは、最初のフレームから隠しておく（フェードは useLiquidClip が毎フレーム上書きする）
  const moving = useLiquidClip(id, ref);
  const onOpenChange = (open: boolean) => {
    // 出発点の角の丸みは本物に合わせる（途中で出発点を下げると、ずれた角が見える）
    const el0 = liquidAnchorElement(anchor);
    const anchorRadius = (el0 && parseFloat(getComputedStyle(el0).borderTopLeftRadius)) || 6;
    const base = { anchor, radius: 8, anchorRadius, fromLook: CHIP_LOOK, toLook: MENU_LOOK, rise: true };
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

/** 指定があれば、待ってから動き出す */
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
  // 行き先は関数で受け取り、測るたびに引き直す
  const targetRef = useRef({
    get current() {
      return job.target();
    },
  }).current as React.RefObject<HTMLElement | null>;
  // 出発点の上に実体を乗せる量（cover / rise）。下げた状態から始める面は 1 から
  const over = useMotionValue(job.lowered ? 1 : 0);
  const { revealed, mounted, layer, edges, settling } = useLiquidMorph(job.open, {
    anchor: job.anchor,
    target: targetRef,
    radius: job.radius ?? 0,
    anchorRadius: job.anchorRadius ?? 8,
    zIndex: job.zIndex ?? 55,
    style,
    sizeLag,
    initiallyOpen: job.initiallyOpen,
    over,
    ...(job.fromLook ? { fromLook: job.fromLook } : {}),
    ...(job.toLook ? { toLook: job.toLook } : {}),
  });

  useEffect(() => {
    useStage.setState((s) => ({ revealed: { ...s.revealed, [job.id]: revealed } }));
  }, [revealed, job.id]);

  // 実体の形を、行き先の画面から読めるようにする（useLiquidClip）
  useEffect(() => {
    liveEdges.set(job.id, edges);
    return () => {
      if (liveEdges.get(job.id) === edges) liveEdges.delete(job.id);
    };
  }, [job.id, edges]);

  // 出発点を下げる（実体を上に乗せる）。下げたあいだ、GPU の描画は実体を出発点の上にも塗る
  useEffect(() => {
    if (!job.cover && !job.rise) return;
    const setLowered = (lowered: boolean) =>
      useStage.setState((s) => {
        const j = s.jobs[job.id];
        if (j?.nonce !== job.nonce || !!j.lowered === lowered) return s;
        return { jobs: { ...s.jobs, [job.id]: { ...j, lowered } } };
      });
    if (job.rise) {
      // メニュー: 開き具合に合わせて、途中から上に乗せる（ぱっと替えず、0.2〜0.5 のあいだに重ねていく）
      const update = (v: number) => {
        const x = Math.min(1, Math.max(0, (v - 0.2) / 0.3));
        const o = x * x * (3 - 2 * x);
        over.set(o);
        setLowered(o > 0);
      };
      update(edges.look.get());
      return edges.look.on("change", update);
    }
    // 全面の画面: 出発点を手前に出す時間を、裏から出る出だし／裏へ戻る終わりだけにする
    const lower = (lowered: boolean) => {
      over.set(lowered ? 1 : 0);
      setLowered(lowered);
    };
    lower(!job.open);
    const t = setTimeout(() => lower(job.open), job.open ? 150 : 300);
    return () => clearTimeout(t);
  }, [job.cover, job.rise, job.open, job.id, job.nonce, edges, over]);

  // 開ききったら、あるいは閉じきったら、登録を外す（開いた面はそのまま見えている）。
  // 開いた後も液架橋の尾が戻りきるまでは残す（そのあいだ、画面の切り抜きやクリックの止めは解く）
  useEffect(() => {
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
  }, [job.open, revealed, mounted, settling, job.id, job.nonce]);

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
