// Words used everywhere (Close, Copy, Cancel, etc.). Shared words live here
import type { common as source } from "../ja/common";

export const common: Record<keyof typeof source, string> = {
  close: "关闭",
  cancel: "取消",
  send: "发送",
  copy: "复制",
  copied: "已复制",
  stop: "停止",
  remove: "移除",
};
