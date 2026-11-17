// pane/MessageActions.tsx（発言の操作、編集の欄、生成中の印）
import type { message as source } from "../ja/message";

export const message: Record<keyof typeof source, string> = {
  copy: "复制",
  copied: "已复制",
  editAndSend: "编辑并发送",
  editAndSendHint: "编辑并发送（开始新的一轮）",
  resend: "重新发送",
  resendHint: "重新发送（开始新的一轮）",
  editLabel: "编辑消息",
  sendsAsNewTurn: "将作为新的一轮发送",
  cancel: "取消",
  send: "发送",
  running: "运行中",
  thinking: "思考中",
  writing: "输出中",
  planning: "规划中",
};
