// pane/Attachments.tsx (attachments, the + menu)
import type { attach as source } from "../ja/attach";

export const attach: Record<keyof typeof source, string> = {
  removeItem: "Remove {name}",
  add: "Attach",
  // {keys} is replaced by a key combination (the Keys component)
  pasteHint: "{keys} pastes an image. Files dropped on the pane are attached too.",
  pickTitle: "Attach files or images",
  attachFiles: "Attach files or images",
  preview: "View {name}",
  closePreview: "Close",
  previousImage: "Previous image",
  nextImage: "Next image",
};
