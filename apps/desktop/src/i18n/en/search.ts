// SearchCard.tsx (⌘K search)
import type { search as source } from "../ja/search";

export const search: Record<keyof typeof source, string> = {
  newSession: "New session",
  switchMode: "Switch mode",
  stopTurn: "Stop the current turn",
  settings: "Settings",
  profiles: "Profiles",
  recent: "Recent sessions",
  messages: "Messages",
  searching: "Searching",
  commands: "Commands",
  close: "Close search",
  label: "Search",
  placeholder: "Search sessions, messages and commands",
  noResults: "No results",
  navigate: "Navigate",
  open: "Open",
};
