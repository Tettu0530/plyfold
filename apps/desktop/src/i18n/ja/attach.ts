// pane/Attachments.tsx (attachments, the + menu)
export const attach = {
  removeItem: "{name} を削除",
  add: "添付",
  // {keys} is replaced by a key combination (the Keys component)
  pasteHint: "{keys} で画像を貼り付け。ペインへのドロップでも添付できます。",
  pickTitle: "添付するファイルや画像",
  attachFiles: "ファイルや画像を添付",
  preview: "{name} を拡大表示",
  closePreview: "閉じる",
  previousImage: "前の画像",
  nextImage: "次の画像",
} satisfies Record<string, string>;
