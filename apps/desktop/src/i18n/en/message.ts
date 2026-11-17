// pane/MessageActions.tsx（発言の操作、編集の欄、生成中の印）
import type { message as source } from "../ja/message";

export const message: Record<keyof typeof source, string> = {
  copy: "Copy",
  copied: "Copied",
  editAndSend: "Edit and send",
  editAndSendHint: "Edit and send (starts a new turn)",
  resend: "Send again",
  resendHint: "Send again (starts a new turn)",
  editLabel: "Edit message",
  sendsAsNewTurn: "Sends as a new turn",
  cancel: "Cancel",
  send: "Send",
  running: "Running",
  thinking: "Thinking",
  writing: "Writing",
  planning: "Planning",
};
