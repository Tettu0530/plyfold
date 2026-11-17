// SessionMenu.tsx (row context menu)
export const sessionMenu = {
  rename: "名前を変える",
  stop: "停止",
  fork: "分岐…",
  forkTitle: "「{title}」を分岐",
  forkNew: "新しい worktree で分岐",
  forkSame: "同じ作業場所で分岐",
  forkNeedsConversation: "まだ会話がありません",
  forkBusy: "ターンの途中です",
  forkStopFirst: "先に停止してください",
  delete: "削除…",
  confirmDelete: "「{title}」を消します",
  deleteWithWorktree: "worktree と枝も消す",
  deleteRecordOnly: "記録だけ消す（worktree は残す）",
  deleteRecord: "記録を消す",
  cancel: "やめる",
} satisfies Record<string, string>;
