// The width of a column at a pane's right edge (the side chat, the review): about 40% of the pane until the user drags
// its left edge, then that width, remembered on this machine
import { useLayoutEffect, useState } from "react";

export const SIDE_MIN = 280;
const SIDE_AUTO_MAX = 420;

function read(key: string): number | null {
  try {
    const n = Number(localStorage.getItem(key));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** [width, set it (drag), back to the automatic width] */
export function useSideColumnWidth(pane: React.RefObject<HTMLElement | null>, key: string): [number, (w: number) => void, () => void] {
  const [paneWidth, setPaneWidth] = useState(850);
  const [stored, setStored] = useState<number | null>(() => read(key));
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => setPaneWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pane]);

  // Wide enough to read, and never more than most of the pane
  const max = Math.max(SIDE_MIN, Math.round(paneWidth * 0.7));
  const width = stored !== null ? Math.min(Math.max(stored, SIDE_MIN), max) : Math.round(Math.min(SIDE_AUTO_MAX, Math.max(SIDE_MIN, paneWidth * 0.4)));
  const set = (w: number) => {
    const next = Math.round(Math.min(Math.max(w, SIDE_MIN), max));
    setStored(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      // Not remembered, still applied
    }
  };
  const reset = () => {
    setStored(null);
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to forget
    }
  };
  return [width, set, reset];
}
