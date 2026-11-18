// pane/ComparePane.tsx (sessions started together from one prompt)
import type { compare as source } from "../ja/compare";

export const compare: Record<keyof typeof source, string> = {
  title: "Compare",
  paneLabel: "Comparing “{title}”",
  empty: "No sessions to compare (moved to the trash or deleted)",
  time: "Time",
  tokens: "Tokens",
  cost: "Cost",
  changes: "Changes",
  files: "{count} files",
  open: "Open",
  diff: "Diff",
  merge: "Merge this one",
  mergeConfirm: "Commits any uncommitted changes, then merges into the original branch",
  mergeYes: "Merge",
  mergeBusy: "Can be merged once it has finished",
  mergeNothing: "No changes to merge",
  mergedInto: "Merged into {target}",
  trashOthersHint: "The other {count} can go to the trash if you no longer need them (restorable from there)",
  trashOthers: "Trash the others",
  openPane: "Compare the {count} started together",
};
