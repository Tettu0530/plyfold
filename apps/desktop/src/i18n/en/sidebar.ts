// Sidebar.tsx
import type { sidebar as source } from "../ja/sidebar";

export const sidebar: Record<keyof typeof source, string> = {
  label: "Sessions",
  newSession: "New session",
  search: "Search",
  empty: "No sessions yet",
  renameLabel: "Session name",
  unread: "Has unread notifications",
  prompts: "Saved prompts",
  profiles: "Profiles",
  settings: "Settings",
  rowTitle: "{title} ({profile}, {age})",
  resize: "Sidebar width",
  resizeHint: "Drag to resize. Double-click to reset.",
  conversations: "Conversations",
  updateAvailable: "Update to {version}",
  updating: "Installing {version}",
  trash: "Trash",
  restore: "Restore “{title}”",
  deleteForGood: "Delete “{title}” for good",
  emptyTrash: "Empty trash",
  trashNote: "Records are deleted after 30 days. Worktrees are kept",
  groupName: "Group name",
  renameGroup: "Rename “{name}”",
};
