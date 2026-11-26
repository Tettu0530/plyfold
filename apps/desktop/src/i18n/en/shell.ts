import type { shell as source } from "../ja/shell";

export const shell: Record<keyof typeof source, string> = {
  stop: "Stop the command",
  stopped: "stopped",
  exit: "exit {code}",
  sendOn: "Send to the agent",
  truncated: "The output was long, so the rest is left out",
};
