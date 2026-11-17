import { useLayoutEffect, useRef } from "react";

/** 入力欄の高さを中身に合わせる（ふだんは 1 行、最大 max px。越えたら中でスクロール） */
export function useAutoGrow(value: string, max = 200) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value, max]);
  return ref;
}
