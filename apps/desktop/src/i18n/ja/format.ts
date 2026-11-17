// lib/format.ts と時刻の書式（経過、何分前 など）
export const format = {
  now: "今",
  minutes: "{n}分",
  hours: "{n}時間",
  yesterday: "昨日",
  days: "{n}日",
  noRepo: "（リポジトリなし）",
} satisfies Record<string, string>;
