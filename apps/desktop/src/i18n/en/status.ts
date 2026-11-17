// icons.tsx (session states, mode names, agent names)
import type { status as source } from "../ja/status";

export const status: Record<keyof typeof source, string> = {
  starting: "Starting",
  working: "Working",
  awaitingPermission: "Waiting for permission",
  stalled: "Stalled",
  error: "Error",
  idle: "Idle",
  closed: "Stopped",
  modeDefault: "Default",
  modeAcceptEdits: "Accept edits",
  modePlan: "Plan",
  modeAuto: "Auto",
  modeBypassPermissions: "Bypass permissions",
  modeReadOnly: "Read only",
  modeWorkspaceWrite: "Workspace write",
  modeAgent: "Auto",
  modeAgentFullAccess: "Full access",
  modeBuild: "Build",
  agentMock: "Mock agent",
};
