// pane/PermissionCard.tsx (permission prompts)
import type { permission as source } from "../ja/permission";

export const permission: Record<keyof typeof source, string> = {
  label: "Permission request",
  defaultTitle: "Allow this tool to run?",
  allowOnce: "Allow once",
  allowAlways: "Always allow",
  denyAndEndTurn: "Deny and end turn",
  deny: "Deny",
  stop: "Stop",
};
