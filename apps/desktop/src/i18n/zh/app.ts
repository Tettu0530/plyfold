// App.tsx (window title, shortcuts, etc.)
import type { app as source } from "../ja/app";

export const app: Record<keyof typeof source, string> = {
  browserOnly: "浏览器中仅可查看（通过 Tauri 启动后会连接到引擎）。",
  showSidebar: "显示侧边栏",
  hideSidebar: "隐藏侧边栏",
};
