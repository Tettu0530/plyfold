import type { shell as source } from "../ja/shell";

export const shell: Record<keyof typeof source, string> = {
  stop: "停止命令",
  stopped: "已停止",
  exit: "退出码 {code}",
  sendOn: "发送给智能体",
  truncated: "输出过长，其余部分已省略",
};
