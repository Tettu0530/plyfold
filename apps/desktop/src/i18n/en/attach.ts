// pane/Attachments.tsx（添えるもの、+ のメニュー）
import type { attach as source } from "../ja/attach";

export const attach: Record<keyof typeof source, string> = {
  removeItem: "Remove {name}",
  pickImageTitle: "Attach images",
  pickFileTitle: "Attach files",
  imageFilter: "Images",
  add: "Attach",
  attachFile: "Attach file",
  attachImage: "Attach image",
  // {keys} はキーの組み合わせ（Keys の部品）に置き換わる
  pasteHint: "{keys} pastes an image. Files dropped on the pane are attached too.",
};
