// Notifications.tsx（ベルの通知の欄）
import type { notifications as source } from "../ja/notifications";

export const notifications: Record<keyof typeof source, string> = {
  awaitingPermission: "等待授权",
  stalled: "无响应",
  stoppedWithError: "因错误而停止",
  turnEndedWithError: "轮次因错误而结束",
  turnEnded: "轮次已结束",
  urgentLabel: "{count} 个会话需要处理",
  newLabel: "{count} 条新通知",
  title: "通知",
  empty: "没有新通知",
};
