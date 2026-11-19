import { useEffect, useState } from "react";

import { inTauri } from "./api";

// Per-OS differences in the UI. Outside a browser (tests) this counts as macOS, the platform the app was built on

export const isMac = typeof navigator === "undefined" || /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The primary shortcut modifier: ⌘ on macOS, Ctrl on Windows and Linux */
export const primaryKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

export const isWindows = typeof navigator !== "undefined" && /Win/.test(navigator.platform || navigator.userAgent);

/**
 * Whether the window is in full screen (macOS hides the traffic lights there, so the header needs no room for them).
 * Checked again whenever the window is resized, which entering and leaving full screen does
 */
export function useFullscreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const check = () =>
        void w.isFullscreen().then(
          (f) => alive && setFull(f),
          () => {},
        );
      check();
      const off = await w.onResized(check);
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return full;
}
