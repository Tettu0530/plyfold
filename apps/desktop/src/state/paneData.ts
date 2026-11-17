// ペインの見出しのボタン（ファイル、バックグラウンド、計画）に出すものを、会話から組み立てる。副作用のない関数だけ
import type { ToolCall, TranscriptItem } from "./transcript";

const tools = (items: TranscriptItem[]) => items.filter((i): i is ToolCall => i.kind === "tool");

export interface TouchedFile {
  path: string;
  /** 編集したか（差分か edit のツール）。読んだだけなら false */
  edited: boolean;
  count: number;
  last: number;
}

/** エージェントが読んだり書いたりしたファイル。最近触ったものから */
export function touchedFiles(items: TranscriptItem[]): TouchedFile[] {
  const by = new Map<string, TouchedFile>();
  tools(items).forEach((t, i) => {
    const at = t.startedAt ?? i;
    const touch = (path: string, edited: boolean) => {
      const f = by.get(path) ?? { path, edited: false, count: 0, last: 0 };
      f.edited ||= edited;
      f.count += 1;
      f.last = Math.max(f.last, at);
      by.set(path, f);
    };
    const edited = t.toolKind === "edit" || t.diffs.length > 0;
    for (const d of t.diffs) touch(d.path, true);
    if (t.path && t.toolKind !== "execute" && !t.diffs.some((d) => d.path === t.path)) touch(t.path, edited);
  });
  return [...by.values()].sort((a, b) => b.last - a.last);
}

export type ShellState = "running" | "done" | "failed" | "stopped" | "unknown";

export interface BackgroundShell {
  id: string | null;
  command: string;
  state: ShellState;
  /** 最後に見た出力（TaskOutput / BashOutput の結果） */
  output: string;
  startedAt: number | null;
}

/** バックグラウンドの ID を結果の文から拾う（「Command running in background with ID: bash_1」など） */
export function backgroundId(result: string): string | null {
  return /\bID\b[:：]?\s*`?([A-Za-z0-9_-]{3,})/i.exec(result)?.[1] ?? null;
}

/**
 * バックグラウンドで動かしたシェル。alive はエージェントが動いているか（止まっていれば、動いていたものも終わっている）
 * 状態は、後から同じ ID を指したツールで分かる: Kill / Stop なら停止、出力の確認の結果に status があればそれ
 */
export function backgroundShells(items: TranscriptItem[], alive: boolean): BackgroundShell[] {
  const all = tools(items);
  return all
    .filter((t) => t.background)
    .map((t) => {
      const id = backgroundId(t.stream || t.result);
      let state: ShellState = alive ? "running" : "unknown";
      let output = "";
      if (t.status === "failed") state = "failed";
      if (id) {
        for (const u of all) {
          if (u === t || !u.refs.includes(id)) continue;
          if (/kill|stop/i.test(u.toolName ?? "")) {
            state = "stopped";
            continue;
          }
          const text = u.stream || u.result;
          if (text) output = text;
          const st = /status[^\w]{0,4}(running|completed|failed|killed)/i.exec(text)?.[1]?.toLowerCase();
          if (st === "completed") state = "done";
          else if (st === "failed") state = "failed";
          else if (st === "killed") state = "stopped";
          else if (st === "running" && alive) state = "running";
        }
      }
      return { id, command: t.command ?? t.title, state, output, startedAt: t.startedAt };
    });
}

export interface PlanEntry {
  content: string;
  status: string;
}

/** 今の計画（最後に届いた plan） */
export function currentPlan(items: TranscriptItem[]): PlanEntry[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "plan") return it.entries;
  }
  return [];
}
