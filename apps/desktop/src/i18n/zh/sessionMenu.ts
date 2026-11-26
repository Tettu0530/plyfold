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
  forkStopFirst: "请先停止智能体",
  delete: "移到废纸篓",
  deleteWithWorktree: "同时删除 worktree 和分支",
  deleteRecordOnly: "仅删除记录（保留 worktree）",
  deleteRecord: "删除记录",
  cancel: "取消",
  handOver: "交接…",
  handOverTitle: "将「{title}」交给另一个智能体。当前智能体会先写一份交接说明再停止，新会话将在同一工作区继续",
  rerun: "再运行一次…",
  rerunTitle: "用另一个配置文件在新 worktree 中运行与「{title}」相同的指令，并并排比较",
  rerunModelTitle: "为「{profile}」选择模型",
  rerunDefaultModel: "默认模型",
};
