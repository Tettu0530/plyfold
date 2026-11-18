// User-facing text from state/store.ts, state/transcript.ts, lib/lineDiff.ts
export const store = {
  fallbackTitle: "セッション",
  notifyPermission: "権限確認待ちです",
  notifyError: "エラーで止まりました: {error}",
  notifyTurnEnded: "ターンが終わりました",
  newSessionTitle: "新しいセッション",
  skippedLines: "… {count} 行",
  newChatTitle: "新しい会話",
} satisfies Record<string, string>;
