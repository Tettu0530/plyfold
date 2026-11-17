import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Fit the input's height to its content (one line by default, at most max px; scrolls inside beyond that).
 * Also refits when the input's width changes (a pane growing from zero width, or being resized), since the number of
 * wrapped lines depends on the width
 */
export function useAutoGrow(value: string, max = 200) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  };
  useLayoutEffect(fit, [value, max]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Refit on the next frame: changing the height inside the callback would trigger another resize in the same
      // frame (a "ResizeObserver loop" warning)
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [max]);
  return ref;
}
