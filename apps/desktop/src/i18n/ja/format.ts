// lib/format.ts and time formats (elapsed, minutes ago, etc.)
export const format = {
  now: "今",
  minutes: "{n}分",
  hours: "{n}時間",
  yesterday: "昨日",
  days: "{n}日",
  noRepo: "（リポジトリなし）",
} satisfies Record<string, string>;
