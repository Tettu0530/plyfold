// pane/Transcript.tsx, pane/ToolCall.tsx, pane/Markdown.tsx (conversation)
import type { transcript as source } from "../ja/transcript";

export const transcript: Record<keyof typeof source, string> = {
  tokPerSecEstimated: "每秒输出 token 数（估算）",
  tokPerSec: "每秒输出 token 数",
  inputTokens: "输入 token",
  outputTokens: "输出 token",
  turnCost: "本轮费用",
  elapsed: "耗时",
  stopped: "已停止",
  endedAt: "完成时间",
  thought: "思考内容",
  empty: "还没有消息",
  plan: "计划",
  sessionCost: "会话费用 {cost}",
  toolRunning: "运行中",
  exitCode: "退出码",
  toolFailed: "失败",
  toolDone: "完成",
  // {n} is replaced by a number component (numbers render monospaced)
  showMore: "显示其余 {n} 行",
  noResult: "还没有结果",
  tool: "工具",
  newFile: "新文件",
  copyCode: "复制代码",
  image: "图片：{alt}",
  scrollToBottom: "跳到最新",
  newBelow: "下方有新输出",
};
