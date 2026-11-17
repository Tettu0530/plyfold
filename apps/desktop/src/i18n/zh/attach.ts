// pane/Attachments.tsx（添えるもの、+ のメニュー）
import type { attach as source } from "../ja/attach";

export const attach: Record<keyof typeof source, string> = {
  removeItem: "移除 {name}",
  pickImageTitle: "附加图片",
  pickFileTitle: "附加文件",
  imageFilter: "图片",
  add: "附加",
  attachFile: "附加文件",
  attachImage: "附加图片",
  // {keys} はキーの組み合わせ（Keys の部品）に置き換わる
  pasteHint: "按 {keys} 粘贴图片。也可以把文件拖到窗格中附加。",
};
