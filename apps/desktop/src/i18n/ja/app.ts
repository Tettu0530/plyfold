// App.tsx (window title, shortcuts, etc.)
export const app = {
  browserOnly: "ブラウザでは表示のみです。エンジンに接続するには Tauri で起動してください。",
  showSidebar: "サイドバーを開く",
  hideSidebar: "サイドバーを閉じる",
} satisfies Record<string, string>;
