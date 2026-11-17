// state/store.ts、state/transcript.ts、lib/lineDiff.ts の画面に出る文
import type { store as source } from "../ja/store";

export const store: Record<keyof typeof source, string> = {
  fallbackTitle: "会话",
  notifyPermission: "等待授权",
  notifyError: "因错误而停止：{error}",
  notifyTurnEnded: "轮次已结束",
  newSessionTitle: "新建会话",
  skippedLines: "… {count} 行",
};
