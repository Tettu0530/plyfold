// App.tsx (window title, shortcuts, etc.)
import type { app as source } from "../ja/app";

export const app: Record<keyof typeof source, string> = {
  browserOnly: "The browser is view-only. Launch with Tauri to connect to the engine.",
  showSidebar: "Show sidebar",
  hideSidebar: "Hide sidebar",
};
