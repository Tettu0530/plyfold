// pane/ComparePane.tsx (sessions started together from one prompt)
import type { compare as source } from "../ja/compare";

export const compare: Record<keyof typeof source, string> = {
  title: "比较",
  paneLabel: "比较「{title}」",
  empty: "没有可比较的会话（已移到废纸篓或已删除）",
  time: "时间",
  tokens: "令牌",
  cost: "费用",
  changes: "更改",
  files: "{count} 个文件",
  open: "打开",
  diff: "差异",
  merge: "合并这个",
  mergeConfirm: "先提交未提交的更改，再合并到原分支",
  mergeYes: "合并",
  mergeBusy: "完成后才能合并",
  mergeNothing: "没有可合并的更改",
  mergedInto: "已合并到 {target}",
  trashOthersHint: "其余 {count} 个如果不再需要，可以移到废纸篓（可从那里恢复）",
  trashOthers: "将其余移到废纸篓",
  openPane: "比较一起开始的 {count} 个",
};
