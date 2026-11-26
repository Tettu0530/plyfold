// pane/PermissionCard.tsx (permission prompts)
export const permission = {
  label: "権限確認",
  defaultTitle: "ツールの実行を許可しますか",
  allowOnce: "今回のみ許可",
  allowAlways: "常に許可",
  denyAndEndTurn: "拒否してターンを終了",
  deny: "拒否",
  stop: "停止",
} satisfies Record<string, string>;
