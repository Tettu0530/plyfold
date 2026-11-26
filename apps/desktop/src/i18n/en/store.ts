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
  compareStartFailed: "One of the sessions started side by side could not start: {error}",
  rerunUnavailable: "This session has no worktree or first instruction, so it cannot be run again",
  rerunFailed: "Could not start the run again: {error}",
};
