// 液体の動き（.claude/skills/no-ai-slop-ui の 4. 動き）
import type { Transition } from "motion/react";

/** ぽよんと跳ねるばね。行き過ぎ 15〜20%、0.5〜0.7 秒で落ち着く */
export const spring: Transition = { type: "spring", stiffness: 520, damping: 20, mass: 0.9 };

/** 動く方向に伸び、止まるときに潰れて戻る（scale だけ。移動とは別の要素にかける） */
export const squashX = {
  initial: { scaleX: 1.32, scaleY: 0.78 },
  animate: { scaleX: 1, scaleY: 1 },
  transition: { type: "spring", stiffness: 380, damping: 9, mass: 0.6 } satisfies Transition,
};

export const squashY = {
  initial: { scaleX: 0.82, scaleY: 1.28 },
  animate: { scaleX: 1, scaleY: 1 },
  transition: { type: "spring", stiffness: 380, damping: 10, mass: 0.6 } satisfies Transition,
};

/** 状態の点から滴が落ちて広がる（権限確認のカード） */
export const dropIn = {
  initial: { opacity: 0, scale: 0.05, y: -28 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.05, y: -28 },
  transition: { type: "spring", stiffness: 420, damping: 17, mass: 0.9 } satisfies Transition,
};
