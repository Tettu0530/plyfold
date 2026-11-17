// どこでも使う語（閉じる、コピー、やめる など）。共有の語はここに置く
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
