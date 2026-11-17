// どこでも使う語（閉じる、コピー、やめる など）。共有の語はここに置く
import type { common as source } from "../ja/common";

export const common: Record<keyof typeof source, string> = {
  close: "Close",
  cancel: "Cancel",
  send: "Send",
  copy: "Copy",
  copied: "Copied",
  stop: "Stop",
  remove: "Remove",
};
