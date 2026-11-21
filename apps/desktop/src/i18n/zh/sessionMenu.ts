// SessionMenu.tsx (row context menu)
import type { sessionMenu as source } from "../ja/sessionMenu";

export const sessionMenu: Record<keyof typeof source, string> = {
  rename: "重命名",
  stop: "停止",
  fork: "分叉…",
  forkTitle: "分叉「{title}」",
  forkNew: "在新 worktree 中分叉",
  forkSame: "在同一工作区中分叉",
  forkNeedsConversation: "还没有可分叉的对话",
  forkBusy: "轮次进行中",
  forkStopFirst: "请先停止代理",
  delete: "移到废纸篓",
  confirmDelete: "删除「{title}」",
  deleteWithWorktree: "同时删除 worktree 和分支",
  deleteRecordOnly: "仅删除记录（保留 worktree）",
  deleteRecord: "删除记录",
  cancel: "取消",
  handOver: "交接…",
  handOverTitle: "将「{title}」交给另一个代理。当前代理会先写一份交接说明再停止，新会话将在同一工作区继续",
};
