// User-facing text from state/store.ts, state/transcript.ts, lib/lineDiff.ts
export const store = {
  fallbackTitle: "セッション",
  notifyPermission: "権限の確認待ちです",
  notifyError: "エラーで停止しました: {error}",
  notifyTurnEnded: "ターンが完了しました",
  newSessionTitle: "新しいセッション",
  skippedLines: "… {count} 行",
  newChatTitle: "新しい会話",
  compareStartFailed: "並列比較で開始したセッションのうち 1 件を開始できませんでした: {error}",
  rerunUnavailable: "このセッションには worktree または最初のプロンプトがないため、再実行できません",
  rerunFailed: "再実行を開始できませんでした: {error}",
} satisfies Record<string, string>;
