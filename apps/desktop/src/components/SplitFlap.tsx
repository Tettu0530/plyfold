import { motion } from "motion/react";
import { useState } from "react";

import { appleSpring } from "./motion";

// パタパタ（反転フラップ式の表示）: 古い表示の上半分が手前に倒れ、新しい表示の下半分が落ちてきて、ばねで少し跳ねて止まる
const FALL = { duration: 0.16, ease: [0.55, 0, 1, 0.45] as const };
const LAND = appleSpring({ duration: 0.4, bounce: 0.35 });

const TOP = "inset(0 0 50% 0)";
const BOTTOM = "inset(50% 0 0 0)";

/** value が変わるたびに、render(value) の表示をパタパタと切り替える */
export function SplitFlap<T extends string>({ value, render, className }: { value: T; render: (v: T) => React.ReactNode; className?: string }) {
  const [prev, setPrev] = useState<T | null>(null);
  const [flip, setFlip] = useState(0);
  const [shown, setShown] = useState(value);
  // 描画の中で前の値を覚える（effect で覚えると、1 フレームだけ新しい値がそのまま見えてしまう）
  if (shown !== value) {
    setPrev(shown);
    setShown(value);
    setFlip((n) => n + 1);
  }

  const cell = "col-start-1 row-start-1 flex items-center gap-1.5";
  if (prev === null) {
    return <span className={`inline-grid ${className ?? ""}`}><span className={cell}>{render(value)}</span></span>;
  }
  // めくれているあいだは、半分ずつを地の色で塗りつぶす（透けると古い文字と新しい文字が重なって見える）
  const solid = `${cell} bg-background`;
  return (
    <span className={`inline-grid [perspective:120px] ${className ?? ""}`}>
      {/* 奥: 新しい上半分と、まだ残っている古い下半分 */}
      <span className={solid} style={{ clipPath: TOP }}>
        {render(value)}
      </span>
      <span className={solid} style={{ clipPath: BOTTOM }} aria-hidden>
        {render(prev)}
      </span>
      {/* 倒れる古い上半分 */}
      <motion.span
        key={`top-${flip}`}
        aria-hidden
        className={solid}
        style={{ clipPath: TOP, transformOrigin: "50% 50%", backfaceVisibility: "hidden" }}
        initial={{ rotateX: 0 }}
        animate={{ rotateX: -90 }}
        transition={FALL}
      >
        {render(prev)}
      </motion.span>
      {/* 落ちてくる新しい下半分（ばねで跳ねて止まる） */}
      <motion.span
        key={`bottom-${flip}`}
        aria-hidden
        className={solid}
        style={{ clipPath: BOTTOM, transformOrigin: "50% 50%", backfaceVisibility: "hidden" }}
        initial={{ rotateX: 90 }}
        animate={{ rotateX: 0 }}
        transition={{ ...LAND, delay: FALL.duration }}
        onAnimationComplete={() => setPrev(null)}
      >
        {render(value)}
      </motion.span>
    </span>
  );
}
