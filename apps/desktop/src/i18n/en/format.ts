// lib/format.ts and time formats (elapsed, minutes ago, etc.)
import type { format as source } from "../ja/format";

export const format: Record<keyof typeof source, string> = {
  now: "now",
  minutes: "{n}m",
  hours: "{n}h",
  yesterday: "yesterday",
  days: "{n}d",
  noRepo: "(no repository)",
};
