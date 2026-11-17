// App.tsx (window title, shortcuts, etc.)
export const app = {
  browserOnly: "ブラウザでは表示だけです（Tauri で起動するとエンジンにつながります）",
  showSidebar: "サイドバーを開く",
  hideSidebar: "サイドバーを閉じる",
} satisfies Record<string, string>;
