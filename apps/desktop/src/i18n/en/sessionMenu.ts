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
  delete: "Move to trash",
  confirmDelete: "Delete “{title}”",
  deleteWithWorktree: "Delete worktree and branch too",
  deleteRecordOnly: "Delete session only (keep worktree)",
  deleteRecord: "Delete session",
  cancel: "Cancel",
  handOver: "Hand over…",
  handOverTitle: "Hand “{title}” over to another agent. The current agent writes a handover note and stops, and a new session carries on in the same workspace",
  rerun: "Run again…",
  rerunTitle: "Run the same instruction as “{title}” with another profile in a new worktree, and compare them side by side",
  rerunModelTitle: "Choose a model for “{profile}”",
  rerunDefaultModel: "Default model",
};
