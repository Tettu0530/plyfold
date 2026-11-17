// SessionMenu.tsx (row context menu)
import type { sessionMenu as source } from "../ja/sessionMenu";

export const sessionMenu: Record<keyof typeof source, string> = {
  rename: "Rename",
  stop: "Stop",
  delete: "Delete…",
  confirmDelete: "Delete “{title}”",
  deleteWithWorktree: "Delete worktree and branch too",
  deleteRecordOnly: "Delete session only (keep worktree)",
  deleteRecord: "Delete session",
  cancel: "Cancel",
};
