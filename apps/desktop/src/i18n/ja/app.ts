// App.tsx (window title, shortcuts, etc.)
export const app = {
  paneCount: "ペインの数",
  panes: "ペイン {count} 枚",
  browserOnly: "ブラウザでは表示だけです（Tauri で起動するとエンジンにつながります）",
  showSidebar: "サイドバーを開く",
  hideSidebar: "サイドバーを閉じる",
} satisfies Record<string, string>;
