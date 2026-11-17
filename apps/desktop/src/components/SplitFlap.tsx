import { motion } from "motion/react";
import { useState } from "react";

import { appleSpring } from "./motion";

// Split-flap display: the old top half flips forward, the new bottom half drops down and settles with a slight spring bounce
const FALL = { duration: 0.16, ease: [0.55, 0, 1, 0.45] as const };
const LAND = appleSpring({ duration: 0.4, bounce: 0.35 });

const TOP = "inset(0 0 50% 0)";
const BOTTOM = "inset(50% 0 0 0)";

/** Flips the rendered render(value) each time value changes */
export function SplitFlap<T extends string>({ value, render, className }: { value: T; render: (v: T) => React.ReactNode; className?: string }) {
  const [prev, setPrev] = useState<T | null>(null);
  const [flip, setFlip] = useState(0);
  const [shown, setShown] = useState(value);
  // Track the previous value during render (doing it in an effect would flash the new value for one frame)
  if (shown !== value) {
    setPrev(shown);
    setShown(value);
    setFlip((n) => n + 1);
  }

  const cell = "col-start-1 row-start-1 flex items-center gap-1.5";
  if (prev === null) {
    return (
      <span className={`inline-grid ${className ?? ""}`}>
        <span className={cell}>{render(value)}</span>
      </span>
    );
  }
  // While flipping, fill each half with the background color (if transparent, old and new text would overlap)
  const solid = `${cell} bg-background`;
  return (
    <span className={`inline-grid [perspective:120px] ${className ?? ""}`}>
      {/* Back: the new top half and the remaining old bottom half */}
      <span className={solid} style={{ clipPath: TOP }}>
        {render(value)}
      </span>
      <span className={solid} style={{ clipPath: BOTTOM }} aria-hidden>
        {render(prev)}
      </span>
      {/* Old top half flipping down */}
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
      {/* New bottom half dropping in (settles with a spring bounce) */}
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
