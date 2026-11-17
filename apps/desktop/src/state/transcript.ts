// Builds a session's conversation from engine events (or the saved log). Pure functions only

import { previewsOfPrompt, type AttachmentPreview } from "@/lib/attachments";
import type { AcpUpdate, EventRecord, PermissionChoice, TurnStats } from "@/lib/types";

export interface DiffPreview {
  path: string;
  oldText: string | null;
  newText: string;
}

export type TranscriptItem =
  | { kind: "user"; text: string; attachments?: AttachmentPreview[] }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | ToolCall
  | { kind: "plan"; entries: { content: string; status: string }[] }
  | { kind: "stats"; stats: TurnStats | null; stopReason: string | null; error: string | null; endedAt: number | null }
  | { kind: "notice"; text: string };

/** A tool call. Agents report these differently, so keep only what we display */
export interface ToolCall {
  kind: "tool";
  id: string;
  title: string;
  toolKind: string;
  status: string;
  diffs: DiffPreview[];
  /** Command that was run (execute) */
  command: string | null;
  /** Files touched */
  path: string | null;
  /** Description supplied by the agent (Claude's description) */
  note: string | null;
  /** Terminal output received incrementally (Codex's terminal_output_delta) */
  stream: string;
  /** Result text (rawOutput, or the text in content) */
  result: string;
  exitCode: number | null;
  /** Tool name (Claude's Bash, TaskOutput, etc.; null if unknown) */
  toolName: string | null;
  /** Run in the background (run_in_background on Claude's Bash) */
  background: boolean;
  /** Background ID referenced in the input (shell_id, bash_id, task_id) */
  refs: string[];
  /** When it first arrived and when it finished (became completed / failed), in ms */
  startedAt: number | null;
  endedAt: number | null;
}

export interface PendingPermission {
  permissionId: string;
  title: string;
  toolCall: Record<string, unknown>;
  options: PermissionChoice[];
}

export interface Transcript {
  items: TranscriptItem[];
  /** Whether a turn is in progress (to skip echoes of prompts the UI sent) */
  inTurn: boolean;
}

export const emptyTranscript = (): Transcript => ({ items: [], inTurn: false });

function text(update: AcpUpdate): string {
  const c = update.content as { type?: string; text?: string } | undefined;
  return c && c.type === "text" && typeof c.text === "string" ? c.text : "";
}

/** Merge consecutive text chunks of the same kind */
function appendText(items: TranscriptItem[], kind: "user" | "agent" | "thought", t: string): TranscriptItem[] {
  if (!t) return items;
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { kind, text: last.text + t }];
  }
  return [...items, { kind, text: t }];
}

function diffsOf(update: AcpUpdate): DiffPreview[] {
  const content = update.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is { type: string; path: string; oldText?: string | null; newText: string } =>
      typeof c === "object" && c !== null && (c as { type?: string }).type === "diff",
    )
    .map((c) => ({ path: c.path, oldText: c.oldText ?? null, newText: c.newText }));
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Strip wrappers like `/bin/zsh -lc 'cat a'` */
export function unwrapShell(cmd: string): string {
  const m = cmd.match(/^\/bin\/(?:ba|z)?sh -l?c '([\s\S]*)'$/);
  return m ? m[1].replace(/'\\''/g, "'") : cmd;
}

function commandOf(input: Record<string, unknown>): string | null {
  const c = input.command ?? input.cmd;
  if (typeof c === "string" && c) return unwrapShell(c);
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    // The ["bash", "-lc", "…"] form
    const a = c as string[];
    if (a.length === 3 && /sh$/.test(a[0]) && /^-l?c$/.test(a[1])) return a[2];
    return a.join(" ");
  }
  return null;
}

/** Text chunks in content. Claude wraps them in ```console … ``` */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((c) => (c as { type?: string; content?: { type?: string; text?: unknown } })?.type === "content" ? (c as { content?: { text?: unknown } }).content?.text : undefined)
    .filter((x): x is string => typeof x === "string");
  if (texts.length === 0) return null;
  return texts.map((x) => x.replace(/^```[\w-]*\n([\s\S]*?)\n?```$/, "$1")).join("\n");
}

function resultOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const o = raw as { output?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof o.output === "string") return o.output;
    if (typeof o.stdout === "string") return [o.stdout, typeof o.stderr === "string" ? o.stderr : ""].filter(Boolean).join("\n");
  }
  return null;
}

/** Overlay a tool_call or tool_call_update onto the current state (per ACP, only the fields present are replaced) */
function mergeTool(prev: ToolCall | null, update: AcpUpdate, now: number | null): ToolCall {
  const base: ToolCall = prev ?? {
    kind: "tool",
    id: String(update.toolCallId ?? ""),
    title: "",
    toolKind: "other",
    status: "pending",
    diffs: [],
    command: null,
    path: null,
    note: null,
    stream: "",
    result: "",
    exitCode: null,
    toolName: null,
    background: false,
    refs: [],
    startedAt: now,
    endedAt: null,
  };
  const next: ToolCall = { ...base };
  if (str(update.title)) next.title = update.title as string;
  if (str(update.kind)) next.toolKind = update.kind as string;
  if (str(update.status)) next.status = update.status as string;
  const input = update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) ? (update.rawInput as Record<string, unknown>) : null;
  const meta0 = update._meta as { claudeCode?: { toolName?: unknown } } | undefined;
  next.toolName = str(meta0?.claudeCode?.toolName) ?? str(update.name) ?? next.toolName;
  if (input) {
    if (input.run_in_background === true) next.background = true;
    const refs = ["shell_id", "bash_id", "task_id"].map((k) => str(input[k])).filter((x): x is string => !!x);
    if (refs.length) next.refs = refs;
    next.command = commandOf(input) ?? next.command;
    next.path = str(input.file_path) ?? str(input.path) ?? str(input.filePath) ?? next.path;
    next.note = str(input.description) ?? next.note;
  }
  const locs = Array.isArray(update.locations) ? (update.locations as { path?: unknown }[]) : [];
  if (locs.length && str(locs[0]?.path)) next.path = locs[0].path as string;
  if (Array.isArray(update.content)) {
    const diffs = diffsOf(update);
    // Keep diffs even if a later update replaces content (Claude sends only the result text at the end)
    if (diffs.length) next.diffs = diffs;
    const text = contentText(update.content);
    // Don't use text identical to the description as the result
    if (text && text !== next.note) next.result = text;
  }
  const raw = resultOf(update.rawOutput);
  if (raw) next.result = raw;
  const meta = (update._meta ?? {}) as { terminal_output_delta?: { data?: unknown }; terminal_exit?: { exit_code?: unknown } };
  if (typeof meta.terminal_output_delta?.data === "string") next.stream = base.stream + meta.terminal_output_delta.data;
  if (typeof meta.terminal_exit?.exit_code === "number") next.exitCode = meta.terminal_exit.exit_code;
  if (next.endedAt == null && (next.status === "completed" || next.status === "failed")) next.endedAt = now;
  return next;
}

/** now is the event time (ms). When rebuilding from the log, pass the logged time */
export function applyUpdate(t: Transcript, update: AcpUpdate, now: number | null = Date.now()): Transcript {
  const kind = update.sessionUpdate;
  switch (kind) {
    case "user_message_chunk":
      // Skip your own messages echoed back during a turn; they were added when sent
      if (t.inTurn) return t;
      return { ...t, items: appendText(t.items, "user", text(update)) };
    case "agent_message_chunk":
      return { ...t, items: appendText(t.items, "agent", text(update)) };
    case "agent_thought_chunk":
      return { ...t, items: appendText(t.items, "thought", text(update)) };
    case "tool_call":
    case "tool_call_update": {
      const id = String(update.toolCallId ?? "");
      // The same tool_call id can arrive twice (e.g. history replayed on reload); merge in that case
      const at = t.items.findIndex((it) => it.kind === "tool" && it.id === id);
      if (at < 0) {
        if (kind === "tool_call_update" && !id) return t;
        return { ...t, items: [...t.items, mergeTool(null, update, now)] };
      }
      const items = t.items.slice();
      items[at] = mergeTool(items[at] as ToolCall, update, now);
      return { ...t, items };
    }
    case "plan": {
      const entries = (Array.isArray(update.entries) ? update.entries : []).map((e) => ({
        content: String((e as { content?: unknown }).content ?? ""),
        status: String((e as { status?: unknown }).status ?? "pending"),
      }));
      // Keep a single plan and replace it on update
      const rest = t.items.filter((it) => it.kind !== "plan");
      return { ...t, items: [...rest, { kind: "plan", entries }] };
    }
    default:
      return t;
  }
}

export function beginTurn(t: Transcript, prompt: string, attachments: AttachmentPreview[] = []): Transcript {
  const item: TranscriptItem = attachments.length ? { kind: "user", text: prompt, attachments } : { kind: "user", text: prompt };
  return { inTurn: true, items: [...t.items, item] };
}

export function endTurn(t: Transcript, stats: TurnStats | null, stopReason: string | null, error: string | null, endedAt: number | null = Date.now()): Transcript {
  return { inTurn: false, items: [...t.items, { kind: "stats", stats, stopReason, error, endedAt }] };
}

export function addNotice(t: Transcript, message: string): Transcript {
  return { ...t, items: [...t.items, { kind: "notice", text: message }] };
}

/** Rebuild the conversation from the saved ACP traffic (readable even when the agent is stopped) */
export function fromHistory(events: EventRecord[]): Transcript {
  let t = emptyTranscript();
  for (const e of events) {
    if (e.kind === "note") {
      // Skip boilerplate like the startup note
      if (!e.payload.startsWith("起動:")) t = addNotice(t, e.payload);
      continue;
    }
    if (e.kind !== "frame_in" && e.kind !== "frame_out") continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(e.payload);
    } catch {
      continue;
    }
    if (e.kind === "frame_out" && msg.method === "session/prompt") {
      const params = msg.params as { prompt?: { type?: string; text?: string }[] } | undefined;
      const blocks = params?.prompt ?? [];
      const prompt = blocks.map((b) => (b.type === undefined || b.type === "text" ? (b.text ?? "") : "")).join("");
      t = beginTurn(t, prompt, previewsOfPrompt(blocks));
    } else if (e.kind === "frame_in" && msg.method === "session/update") {
      const params = msg.params as { update?: AcpUpdate } | undefined;
      if (params?.update) t = applyUpdate(t, params.update, e.ts || null);
    } else if (e.kind === "frame_in" && t.inTurn && msg.result && typeof msg.result === "object") {
      const result = msg.result as { stopReason?: string; usage?: Record<string, number> };
      if (typeof result.stopReason === "string") {
        const u = result.usage;
        const stats: TurnStats | null = u
          ? {
              usage: {
                input: u.inputTokens ?? 0,
                output: u.outputTokens ?? 0,
                cached_read: u.cachedReadTokens ?? 0,
                cached_write: u.cachedWriteTokens ?? 0,
                thought: u.thoughtTokens ?? 0,
                total: u.totalTokens ?? 0,
              },
              elapsed_ms: 0,
              ttft_ms: null,
              tokens_per_sec: null,
              estimated: false,
            }
          : null;
        t = endTurn(t, stats, result.stopReason, null, e.ts || null);
      }
    }
  }
  return t;
}
