// セッションの会話を、エンジンのイベント（または保存した記録）から組み立てる。副作用のない関数だけ

import type { AcpUpdate, EventRecord, PermissionChoice, TurnStats } from "@/lib/types";

export interface DiffPreview {
  path: string;
  oldText: string | null;
  newText: string;
}

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool";
      id: string;
      title: string;
      toolKind: string;
      status: string;
      diffs: DiffPreview[];
    }
  | { kind: "plan"; entries: { content: string; status: string }[] }
  | { kind: "stats"; stats: TurnStats | null; stopReason: string | null; error: string | null }
  | { kind: "notice"; text: string };

export interface PendingPermission {
  permissionId: string;
  title: string;
  toolCall: Record<string, unknown>;
  options: PermissionChoice[];
}

export interface Transcript {
  items: TranscriptItem[];
  /** ターンの途中か（UI が送ったプロンプトの再掲を除くため） */
  inTurn: boolean;
}

export const emptyTranscript = (): Transcript => ({ items: [], inTurn: false });

function text(update: AcpUpdate): string {
  const c = update.content as { type?: string; text?: string } | undefined;
  return c && c.type === "text" && typeof c.text === "string" ? c.text : "";
}

/** 連続する同じ種類の文字の塊はつなげる */
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

export function applyUpdate(t: Transcript, update: AcpUpdate): Transcript {
  const kind = update.sessionUpdate;
  switch (kind) {
    case "user_message_chunk":
      // ターン中に送り返される自分の発言は、送ったときに入れてあるので出さない
      if (t.inTurn) return t;
      return { ...t, items: appendText(t.items, "user", text(update)) };
    case "agent_message_chunk":
      return { ...t, items: appendText(t.items, "agent", text(update)) };
    case "agent_thought_chunk":
      return { ...t, items: appendText(t.items, "thought", text(update)) };
    case "tool_call": {
      const id = String(update.toolCallId ?? "");
      return {
        ...t,
        items: [
          ...t.items,
          {
            kind: "tool",
            id,
            title: String(update.title ?? ""),
            toolKind: String(update.kind ?? "other"),
            status: String(update.status ?? "pending"),
            diffs: diffsOf(update),
          },
        ],
      };
    }
    case "tool_call_update": {
      const id = String(update.toolCallId ?? "");
      return {
        ...t,
        items: t.items.map((it) =>
          it.kind === "tool" && it.id === id
            ? {
                ...it,
                title: typeof update.title === "string" && update.title ? update.title : it.title,
                status: typeof update.status === "string" ? update.status : it.status,
                diffs: [...it.diffs, ...diffsOf(update)],
              }
            : it,
        ),
      };
    }
    case "plan": {
      const entries = (Array.isArray(update.entries) ? update.entries : []).map((e) => ({
        content: String((e as { content?: unknown }).content ?? ""),
        status: String((e as { status?: unknown }).status ?? "pending"),
      }));
      // 計画は 1 つだけ持ち、更新されたら置き換える
      const rest = t.items.filter((it) => it.kind !== "plan");
      return { ...t, items: [...rest, { kind: "plan", entries }] };
    }
    default:
      return t;
  }
}

export function beginTurn(t: Transcript, prompt: string): Transcript {
  return { inTurn: true, items: [...t.items, { kind: "user", text: prompt }] };
}

export function endTurn(t: Transcript, stats: TurnStats | null, stopReason: string | null, error: string | null): Transcript {
  return { inTurn: false, items: [...t.items, { kind: "stats", stats, stopReason, error }] };
}

export function addNotice(t: Transcript, message: string): Transcript {
  return { ...t, items: [...t.items, { kind: "notice", text: message }] };
}

/** 保存した ACP の送受信から、会話を組み立て直す（エージェントが止まっていても読める） */
export function fromHistory(events: EventRecord[]): Transcript {
  let t = emptyTranscript();
  for (const e of events) {
    if (e.kind === "note") {
      // 起動の記録など、毎回出るものは省く
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
      const params = msg.params as { prompt?: { text?: string }[] } | undefined;
      const prompt = (params?.prompt ?? []).map((b) => b.text ?? "").join("");
      t = beginTurn(t, prompt);
    } else if (e.kind === "frame_in" && msg.method === "session/update") {
      const params = msg.params as { update?: AcpUpdate } | undefined;
      if (params?.update) t = applyUpdate(t, params.update);
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
        t = endTurn(t, stats, result.stopReason, null);
      }
    }
  }
  return t;
}
