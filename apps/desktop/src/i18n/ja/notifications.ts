// Notifications.tsx (bell notification panel)
export const notifications = {
  awaitingPermission: "権限確認待ち",
  stalled: "無応答",
  stoppedWithError: "エラーで止まりました",
  turnEndedWithError: "ターンがエラーで終わりました",
  turnEnded: "ターンが終わりました",
  urgentLabel: "対応が必要なセッション {count} 件",
  newLabel: "新しい通知 {count} 件",
  title: "通知",
  empty: "通知はありません。",
} satisfies Record<string, string>;
