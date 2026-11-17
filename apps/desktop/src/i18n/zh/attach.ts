// pane/Attachments.tsx (attachments, the + menu)
import type { attach as source } from "../ja/attach";

export const attach: Record<keyof typeof source, string> = {
  removeItem: "移除 {name}",
  add: "附加",
  // {keys} is replaced by a key combination (the Keys component)
  pasteHint: "按 {keys} 粘贴图片。也可以把文件拖到窗格中附加。",
  pickTitle: "添加文件或图片",
  attachFiles: "添加文件或图片",
};
