// Words used everywhere (Close, Copy, Cancel, etc.). Shared words live here
import type { common as source } from "../ja/common";

export const common: Record<keyof typeof source, string> = {
  close: "Close",
  cancel: "Cancel",
};
