// pane/Composer.tsx (input box, model / effort, context, queue)
import type { composer as source } from "../ja/composer";

export const composer: Record<keyof typeof source, string> = {
  inputTotal: "输入（累计）",
  cachedPart: "其中缓存",
  outputTotal: "输出（累计）",
  costTotal: "费用（累计）",
  contextDetails: "上下文详情",
  contextUsage: "上下文用量",
  context: "上下文",
  reportedModel: "响应模型",
  switchMode: "切换 mode（当前：{mode}，⇧⇥）",
  queueSendAfterTurn: "本轮结束后发送",
  queueUnsent: "未发送的消息",
  sendFirst: "发送第一条",
  attachmentsCount: "{count} 个附件",
  removeFromQueue: "移出队列",
  message: "消息",
  stopEsc: "停止 (esc)",
  addToQueue: "加入队列",
  send: "发送",
  addToQueueHint: "加入队列（本轮结束后发送）",
  mentionLabel: "文件",
  mentionEmpty: "没有匹配的文件",
  mentionLoading: "正在搜索文件",
};
