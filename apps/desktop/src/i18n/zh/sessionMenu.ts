// SessionMenu.tsx (row context menu)
import type { sessionMenu as source } from "../ja/sessionMenu";

export const sessionMenu: Record<keyof typeof source, string> = {
  rename: "重命名",
  stop: "停止",
  delete: "删除…",
  confirmDelete: "删除「{title}」",
  deleteWithWorktree: "同时删除 worktree 和分支",
  deleteRecordOnly: "仅删除记录（保留 worktree）",
  deleteRecord: "删除记录",
  cancel: "取消",
};
