// App.tsx（窓の見出し、ショートカットなど）
export const app = {
  paneCount: "ペインの数",
  panes: "ペイン {count} 枚",
  browserOnly: "ブラウザでは表示だけです（Tauri で起動するとエンジンにつながります）",
} satisfies Record<string, string>;
