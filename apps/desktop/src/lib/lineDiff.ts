// Line diff of two strings (for small inline diffs in conversations; large diffs come from git in the diff screen)
import { t } from "@/i18n";
import type { PatchLine } from "./patch";

/** Above this the LCS table gets too heavy, so treat it as delete-all plus add-all */
const MAX_CELLS = 4_000_000;

function split(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  // A trailing newline doesn't add a line
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line diff. No header lines; unchanged lines keep only `context` lines on each side and the rest collapse into "… N lines" */
export function lineDiff(oldText: string | null, newText: string, context = 3): { lines: PatchLine[]; added: number; removed: number } {
  const a = split(oldText);
  const b = split(newText);
  // Strip common leading and trailing lines first (keeps the table small)
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  type Op = { k: "ctx" | "add" | "del"; text: string };
  const mid: Op[] = [];
  if (am.length * bm.length > MAX_CELLS) {
    for (const t of am) mid.push({ k: "del", text: t });
    for (const t of bm) mid.push({ k: "add", text: t });
  } else {
    // LCS length table (built from the end)
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        mid.push({ k: "ctx", text: am[i] });
        i++;
        j++;
      } else if (i < n && (j === m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        // On a tie, deletions come first (same order as git)
        mid.push({ k: "del", text: am[i++] });
      } else {
        mid.push({ k: "add", text: bm[j++] });
      }
    }
  }
  const ops: Op[] = [...a.slice(0, pre).map((t) => ({ k: "ctx" as const, text: t })), ...mid, ...a.slice(a.length - suf).map((t) => ({ k: "ctx" as const, text: t }))];

  // Number the lines and collapse unchanged lines more than `context` lines from a change
  const near = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.k === "ctx") return;
    for (let d = Math.max(0, idx - context); d <= Math.min(ops.length - 1, idx + context); d++) near[d] = true;
  });
  const lines: PatchLine[] = [];
  let on = 1;
  let nn = 1;
  let skipped = 0;
  let added = 0;
  let removed = 0;
  const flush = () => {
    if (skipped) lines.push({ kind: "note", old: null, new: null, text: t("store.skippedLines", { count: skipped }) });
    skipped = 0;
  };
  for (let idx = 0; idx < ops.length; idx++) {
    const o = ops[idx];
    if (o.k === "ctx" && !near[idx]) {
      skipped++;
      on++;
      nn++;
      continue;
    }
    flush();
    if (o.k === "ctx") lines.push({ kind: "ctx", old: on++, new: nn++, text: o.text });
    else if (o.k === "del") {
      lines.push({ kind: "del", old: on++, new: null, text: o.text });
      removed++;
    } else {
      lines.push({ kind: "add", old: null, new: nn++, text: o.text });
      added++;
    }
  }
  flush();
  return { lines, added, removed };
}
