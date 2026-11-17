// pane/Attachments.tsx (attachments, the + menu)
export const attach = {
  removeItem: "{name} を外す",
  pickImageTitle: "添える画像",
  pickFileTitle: "添えるファイル",
  imageFilter: "画像",
  add: "添える",
  attachFile: "ファイルを添える",
  attachImage: "画像を添える",
  // {keys} is replaced by a key combination (the Keys component)
  pasteHint: "{keys} で画像を貼り付け。ペインに落としても添えられます",
} satisfies Record<string, string>;
