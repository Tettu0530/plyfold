// SessionMenu.tsx (row context menu)
import type { sessionMenu as source } from "../ja/sessionMenu";

export const sessionMenu: Record<keyof typeof source, string> = {
  rename: "Rename",
  stop: "Stop",
  fork: "Fork…",
  forkTitle: "Fork “{title}”",
  forkNew: "Fork into a new worktree",
  forkSame: "Fork in this workspace",
  forkNeedsConversation: "No conversation to fork yet",
  forkBusy: "A turn is in progress",
  forkStopFirst: "Stop the agent first",
  delete: "Delete…",
  confirmDelete: "Delete “{title}”",
  deleteWithWorktree: "Delete worktree and branch too",
  deleteRecordOnly: "Delete session only (keep worktree)",
  deleteRecord: "Delete session",
  cancel: "Cancel",
};
