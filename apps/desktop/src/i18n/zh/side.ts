import type { side as source } from "../ja/side";

export const side: Record<keyof typeof source, string> = {
  open: "侧边对话",
  title: "侧边对话",
  forkedNow: "刚刚分叉",
  forkedAgo: "{n} 分钟前分叉",
  refresh: "从主对话的当前状态重新分叉（此处的对话会被清除）",
  close: "关闭（此处的对话会被清除）",
  starting: "正在复制主对话",
  hint: "这是主对话的分叉。这里的问答不会进入主对话。编辑文件和执行命令会被拒绝",
  quote: "添加到主输入框",
  placeholder: "就主会话提问",
};
