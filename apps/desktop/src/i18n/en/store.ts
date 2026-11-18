// User-facing text from state/store.ts, state/transcript.ts, lib/lineDiff.ts
import type { store as source } from "../ja/store";

export const store: Record<keyof typeof source, string> = {
  fallbackTitle: "Session",
  notifyPermission: "Waiting for permission",
  notifyError: "Stopped with an error: {error}",
  notifyTurnEnded: "Turn ended",
  newSessionTitle: "New session",
  skippedLines: "… {count, plural, one {# line} other {# lines}}",
  newChatTitle: "New conversation",
};
