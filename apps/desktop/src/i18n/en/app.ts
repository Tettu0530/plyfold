// App.tsx (window title, shortcuts, etc.)
import type { app as source } from "../ja/app";

export const app: Record<keyof typeof source, string> = {
  paneCount: "Number of panes",
  panes: "{count, plural, one {# pane} other {# panes}}",
  browserOnly: "The browser is view-only. Launch with Tauri to connect to the engine.",
  showSidebar: "Show sidebar",
  hideSidebar: "Hide sidebar",
};
