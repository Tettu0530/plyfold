// lib/format.ts と時刻の書式（経過、何分前 など）
import type { format as source } from "../ja/format";

export const format: Record<keyof typeof source, string> = {
  now: "刚刚",
  minutes: "{n}分钟",
  hours: "{n}小时",
  yesterday: "昨天",
  days: "{n}天",
  noRepo: "（无仓库）",
};
