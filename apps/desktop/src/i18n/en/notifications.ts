// Notifications.tsx (bell notification panel)
import type { notifications as source } from "../ja/notifications";

export const notifications: Record<keyof typeof source, string> = {
  awaitingPermission: "Waiting for permission",
  stalled: "Stalled",
  stoppedWithError: "Stopped with an error",
  turnEndedWithError: "Turn ended with an error",
  turnEnded: "Turn ended",
  urgentLabel: "{count, plural, one {# session needs attention} other {# sessions need attention}}",
  newLabel: "{count, plural, one {# new notification} other {# new notifications}}",
  title: "Notifications",
  empty: "No notifications.",
};
