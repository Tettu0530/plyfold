// state/store.ts、state/transcript.ts、lib/lineDiff.ts の画面に出る文
export const store = {
  fallbackTitle: "セッション",
  notifyPermission: "権限確認待ちです",
  notifyError: "エラーで止まりました: {error}",
  notifyTurnEnded: "ターンが終わりました",
  newSessionTitle: "新しいセッション",
  skippedLines: "… {count} 行",
} satisfies Record<string, string>;
