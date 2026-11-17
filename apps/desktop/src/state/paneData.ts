// Builds the contents of the pane header buttons (files, background, plan) from the conversation. Pure functions only
import { localUrls } from "@/lib/urls";
import type { ToolCall, TranscriptItem } from "./transcript";

const tools = (items: TranscriptItem[]) => items.filter((i): i is ToolCall => i.kind === "tool");

export interface TouchedFile {
  path: string;
  /** Whether it was edited (a diff or an edit tool). false if only read */
  edited: boolean;
  count: number;
  last: number;
}

/** Files the agent read or wrote, most recently touched first */
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
  /** Last seen output (result of TaskOutput / BashOutput) */
  output: string;
  startedAt: number | null;
}

/** Extract the background ID from result text (e.g. "Command running in background with ID: bash_1") */
export function backgroundId(result: string): string | null {
  return /\bID\b[:：]?\s*`?([A-Za-z0-9_-]{3,})/i.exec(result)?.[1] ?? null;
}

/**
 * Shells run in the background. alive is whether the agent is running (if it stopped, its shells are gone too).
 * Status comes from later tools referencing the same ID: Kill / Stop means stopped; otherwise the status in an output check, if any
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

/** Current plan (the last plan received) */
export function currentPlan(items: TranscriptItem[]): PlanEntry[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "plan") return it.entries;
  }
  return [];
}

/** localhost URLs printed by commands in this conversation (dev servers and the like), most recent first */
export function previewUrls(items: TranscriptItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const all = tools(items);
  for (let i = all.length - 1; i >= 0; i--) {
    for (const url of localUrls(`${all[i].stream}\n${all[i].result}`)) {
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}
