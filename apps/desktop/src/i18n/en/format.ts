// lib/format.ts と時刻の書式（経過、何分前 など）
import type { format as source } from "../ja/format";

export const format: Record<keyof typeof source, string> = {
  now: "now",
  minutes: "{n}m",
  hours: "{n}h",
  yesterday: "yesterday",
  days: "{n}d",
  noRepo: "(no repository)",
};
