// pane/Attachments.tsx（添えるもの、+ のメニュー）
export const attach = {
  removeItem: "{name} を外す",
  pickImageTitle: "添える画像",
  pickFileTitle: "添えるファイル",
  imageFilter: "画像",
  add: "添える",
  attachFile: "ファイルを添える",
  attachImage: "画像を添える",
  // {keys} はキーの組み合わせ（Keys の部品）に置き換わる
  pasteHint: "{keys} で画像を貼り付け。ペインに落としても添えられます",
} satisfies Record<string, string>;
