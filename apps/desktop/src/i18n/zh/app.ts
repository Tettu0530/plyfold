// App.tsx (window title, shortcuts, etc.)
import type { app as source } from "../ja/app";

export const app: Record<keyof typeof source, string> = {
  paneCount: "窗格数",
  panes: "{count} 个窗格",
  browserOnly: "浏览器中仅可查看（通过 Tauri 启动后会连接到引擎）。",
};
