// 分離アニメーションの規格の入口（.claude/skills/no-ai-slop-ui の 4. 動き）
//
//   liquidOpen("pane-0", { anchor: "session:<id>", target: () => 要素 })   … 出発点の裏から飛び出して、行き先に広がる
//   liquidClose("pane-0")                                                … 行き先から縮んで、出発点の裏へ戻る
//   liquidCloseFrom("pane-0", { anchor, target })                        … 今表示中の面を、閉じる動きで出発点へ戻す
//   useLiquidRevealed("pane-0")                                          … 本物を見せてよいか（動いているあいだは false）
//
// 実体の描画は、アプリに 1 つ置く <LiquidStage /> がまとめて行う。
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { useStore } from "@/state/store";
import { useLiquidMorph, type Look } from "./liquid";

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
  fromLook?: Look;
  toLook?: Look;
}

interface Job extends LiquidJobOptions {
  id: string;
  open: boolean;
  initiallyOpen: boolean;
  /** 同じ id で開き直したときに作り直すための番号 */
  nonce: number;
  /** cover のとき、いま出発点を実体の下に下げているか */
  lowered?: boolean;
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
    jobs: { ...s.jobs, [id]: { ...opts, id, open: false, initiallyOpen: true, nonce: ++nonce } },
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

/** いま動いている分離アニメーションの出発点の名前（出発点を実体より手前に出すため） */
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
  const { revealed, mounted, layer } = useLiquidMorph(job.open, {
    anchor: job.anchor,
    target: targetRef,
    radius: job.radius ?? 0,
    anchorRadius: job.anchorRadius ?? 8,
    zIndex: job.zIndex ?? 55,
    style,
    sizeLag,
    initiallyOpen: job.initiallyOpen,
    ...(job.fromLook ? { fromLook: job.fromLook } : {}),
    ...(job.toLook ? { toLook: job.toLook } : {}),
  });

  useEffect(() => {
    useStage.setState((s) => ({ revealed: { ...s.revealed, [job.id]: revealed } }));
  }, [revealed, job.id]);

  // 全面の画面: 出発点を手前に出す時間を、裏から出る出だし／裏へ戻る終わりだけにする
  useEffect(() => {
    if (!job.cover) return;
    const setLowered = (lowered: boolean) =>
      useStage.setState((s) => (s.jobs[job.id]?.nonce === job.nonce ? { jobs: { ...s.jobs, [job.id]: { ...s.jobs[job.id], lowered } } } : s));
    setLowered(!job.open);
    const t = setTimeout(() => setLowered(job.open), job.open ? 150 : 300);
    return () => clearTimeout(t);
  }, [job.cover, job.open, job.id, job.nonce]);

  // 開ききったら、あるいは閉じきったら、登録を外す（開いた面はそのまま見えている）
  useEffect(() => {
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
  }, [job.open, revealed, mounted, job.id, job.nonce]);

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
