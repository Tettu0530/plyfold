// User-facing text from state/store.ts, state/transcript.ts, lib/lineDiff.ts
export const store = {
  fallbackTitle: "セッション",
  notifyPermission: "権限確認待ちです",
  notifyError: "エラーで止まりました: {error}",
  notifyTurnEnded: "ターンが終わりました",
  newSessionTitle: "新しいセッション",
  skippedLines: "… {count} 行",
  newChatTitle: "新しい会話",
  compareStartFailed: "並べて始めたうちの 1 つを始められませんでした: {error}",
  rerunUnavailable: "このセッションには作業フォルダか、最初の指示がないため、もう一度実行できません",
  rerunFailed: "もう一度実行を始められませんでした: {error}",
} satisfies Record<string, string>;
