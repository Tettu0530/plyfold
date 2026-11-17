// Sidebar.tsx
import type { sidebar as source } from "../ja/sidebar";

export const sidebar: Record<keyof typeof source, string> = {
  label: "Sessions",
  newSession: "New session",
  search: "Search",
  empty: "No sessions yet",
  renameLabel: "Session name",
  unread: "Has unread notifications",
  profiles: "Profiles",
  settings: "Settings",
};
