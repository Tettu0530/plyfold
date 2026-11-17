// pane/Attachments.tsx (attachments, the + menu)
import type { attach as source } from "../ja/attach";

export const attach: Record<keyof typeof source, string> = {
  removeItem: "Remove {name}",
  pickImageTitle: "Attach images",
  pickFileTitle: "Attach files",
  imageFilter: "Images",
  add: "Attach",
  attachFile: "Attach file",
  attachImage: "Attach image",
  // {keys} is replaced by a key combination (the Keys component)
  pasteHint: "{keys} pastes an image. Files dropped on the pane are attached too.",
};
