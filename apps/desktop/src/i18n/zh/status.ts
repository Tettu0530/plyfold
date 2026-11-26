// icons.tsx (session states, mode names, agent names)
import type { status as source } from "../ja/status";

export const status: Record<keyof typeof source, string> = {
  starting: "启动中",
  working: "运行中",
  answering: "回答中",
  awaitingPermission: "等待授权",
  stalled: "无响应",
  error: "错误",
  idle: "空闲",
  closed: "已停止",
  modeDefault: "默认",
  modeAcceptEdits: "接受编辑",
  modePlan: "计划",
  modeAuto: "自动",
  modeBypassPermissions: "跳过权限",
  modeReadOnly: "只读",
  modeWorkspaceWrite: "可写工作区",
  modeAgent: "自动",
  modeAgentFullAccess: "完全访问",
  modeBuild: "构建",
  agentMock: "模拟智能体",
};
