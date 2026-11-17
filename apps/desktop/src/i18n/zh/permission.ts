// pane/PermissionCard.tsx (permission prompts)
import type { permission as source } from "../ja/permission";

export const permission: Record<keyof typeof source, string> = {
  label: "权限请求",
  defaultTitle: "允许运行此工具吗？",
  allowOnce: "仅允许本次",
  allowAlways: "始终允许",
  denyAndEndTurn: "拒绝并结束本轮",
  deny: "拒绝",
  stop: "停止",
};
