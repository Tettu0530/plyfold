import { useLayoutEffect, useRef } from "react";

/** Fit the input's height to its content (one line by default, at most max px; scrolls inside beyond that) */
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
