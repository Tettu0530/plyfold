// pane/PermissionCard.tsx (permission prompts)
export const permission = {
  label: "権限確認",
  defaultTitle: "ツールを実行してよいですか",
  allowOnce: "今回だけ許可",
  allowAlways: "常に許可",
  denyAndEndTurn: "拒否してターンを終える",
  deny: "拒否",
  stop: "停止",
} satisfies Record<string, string>;
