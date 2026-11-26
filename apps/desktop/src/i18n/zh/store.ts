// User-facing text from state/store.ts, state/transcript.ts, lib/lineDiff.ts
import type { store as source } from "../ja/store";

export const store: Record<keyof typeof source, string> = {
  fallbackTitle: "会话",
  notifyPermission: "等待授权",
  notifyError: "因错误而停止：{error}",
  notifyTurnEnded: "轮次已结束",
  newSessionTitle: "新建会话",
  skippedLines: "… {count} 行",
  newChatTitle: "新对话",
  compareStartFailed: "并排启动的会话中有一个无法启动：{error}",
  rerunUnavailable: "此会话没有 worktree 或首条指令，无法重新运行",
  rerunFailed: "无法重新开始运行：{error}",
};
