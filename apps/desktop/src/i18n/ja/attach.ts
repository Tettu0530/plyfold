// pane/Attachments.tsx (attachments, the + menu)
export const attach = {
  removeItem: "{name} を外す",
  add: "添える",
  // {keys} is replaced by a key combination (the Keys component)
  pasteHint: "{keys} で画像を貼り付け。ペインに落としても添えられます",
  pickTitle: "添えるファイルや画像",
  attachFiles: "ファイルや画像を添える",
  preview: "{name} を大きく見る",
  closePreview: "閉じる",
} satisfies Record<string, string>;
