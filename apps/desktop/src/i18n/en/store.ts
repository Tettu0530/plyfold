// state/store.ts、state/transcript.ts、lib/lineDiff.ts の画面に出る文
import type { store as source } from "../ja/store";

export const store: Record<keyof typeof source, string> = {
  fallbackTitle: "Session",
  notifyPermission: "Waiting for permission",
  notifyError: "Stopped with an error: {error}",
  notifyTurnEnded: "Turn ended",
  newSessionTitle: "New session",
  skippedLines: "… {count, plural, one {# line} other {# lines}}",
};
