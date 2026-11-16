import { describe, expect, it } from "vitest";

import type { EventRecord } from "@/lib/types";
import { applyUpdate, beginTurn, emptyTranscript, endTurn, fromHistory } from "./transcript";

const chunk = (sessionUpdate: string, text: string) => ({ sessionUpdate, content: { type: "text", text } });

describe("transcript", () => {
  it("joins consecutive chunks and skips echoed user text during a turn", () => {
    let t = beginTurn(emptyTranscript(), "hello");
    t = applyUpdate(t, chunk("user_message_chunk", "hello"));
    t = applyUpdate(t, chunk("agent_message_chunk", "echo: "));
    t = applyUpdate(t, chunk("agent_message_chunk", "hello"));
    t = endTurn(t, null, "end_turn", null);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "agent", "stats"]);
    expect(t.items[1]).toEqual({ kind: "agent", text: "echo: hello" });
    expect(t.inTurn).toBe(false);
  });

  it("tracks tool calls and attaches diffs from updates", () => {
    let t = applyUpdate(emptyTranscript(), { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write", kind: "edit", status: "pending" });
    t = applyUpdate(t, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "diff", path: "/w/a.txt", oldText: null, newText: "hi\n" }],
    });
    const tool = t.items[0];
    expect(tool.kind).toBe("tool");
    if (tool.kind === "tool") {
      expect(tool.status).toBe("completed");
      expect(tool.diffs).toEqual([{ path: "/w/a.txt", oldText: null, newText: "hi\n" }]);
    }
  });

  it("reads Claude's Bash: command, description and output", () => {
    const id = "toolu_1";
    let t = applyUpdate(emptyTranscript(), { sessionUpdate: "tool_call", toolCallId: id, rawInput: {}, status: "pending", title: "Terminal", kind: "execute", content: [] });
    t = applyUpdate(t, { sessionUpdate: "tool_call_update", toolCallId: id, rawInput: { command: "date" }, title: "date" });
    t = applyUpdate(t, {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      rawInput: { command: "date", description: "Show the date" },
      content: [{ type: "content", content: { type: "text", text: "Show the date" } }],
    });
    t = applyUpdate(t, {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status: "completed",
      rawOutput: "Mon Nov 16",
      content: [{ type: "content", content: { type: "text", text: "```console\nMon Nov 16\n```" } }],
    });
    expect(t.items[0]).toMatchObject({ kind: "tool", title: "date", command: "date", note: "Show the date", result: "Mon Nov 16", status: "completed" });
  });

  it("collects Codex's streamed terminal output and exit code", () => {
    const id = "exec-1";
    let t = applyUpdate(emptyTranscript(), {
      sessionUpdate: "tool_call",
      toolCallId: id,
      kind: "execute",
      title: "cargo test",
      status: "in_progress",
      content: [{ type: "terminal", terminalId: id }],
      rawInput: { command: "/bin/zsh -lc 'cargo test'", cwd: "/w" },
    });
    t = applyUpdate(t, { sessionUpdate: "tool_call_update", toolCallId: id, _meta: { terminal_output_delta: { data: "running\n" } } });
    t = applyUpdate(t, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", _meta: { terminal_output_delta: { data: "failed\n" }, terminal_exit: { exit_code: 101 } } });
    expect(t.items[0]).toMatchObject({ command: "cargo test", stream: "running\nfailed\n", exitCode: 101 });
  });

  it("merges a repeated tool_call instead of adding a second row", () => {
    let t = applyUpdate(emptyTranscript(), { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a", kind: "read", status: "completed" });
    t = applyUpdate(t, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a", kind: "read", status: "completed" });
    expect(t.items).toHaveLength(1);
  });

  it("shows attachments of a stored prompt", () => {
    const frame = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        prompt: [
          { type: "text", text: "これを見て" },
          { type: "image", data: "AAAA", mimeType: "image/png", uri: "file:///tmp/a%20b.png" },
          { type: "resource_link", name: "notes.md", uri: "file:///tmp/notes.md" },
        ],
      },
    };
    const t = fromHistory([{ id: 1, session_id: "s", ts: 0, kind: "frame_out", payload: JSON.stringify(frame) }]);
    expect(t.items[0]).toEqual({
      kind: "user",
      text: "これを見て",
      attachments: [
        { kind: "image", name: "a b.png", src: "data:image/png;base64,AAAA" },
        { kind: "file", name: "notes.md" },
      ],
    });
  });

  it("keeps a single plan and replaces it", () => {
    let t = applyUpdate(emptyTranscript(), { sessionUpdate: "plan", entries: [{ content: "a", status: "pending" }] });
    t = applyUpdate(t, chunk("agent_message_chunk", "x"));
    t = applyUpdate(t, { sessionUpdate: "plan", entries: [{ content: "a", status: "completed" }] });
    expect(t.items.filter((i) => i.kind === "plan")).toHaveLength(1);
    expect(t.items[t.items.length - 1]).toEqual({ kind: "plan", entries: [{ content: "a", status: "completed" }] });
  });

  it("rebuilds from stored frames, replayed history included", () => {
    const ev = (id: number, kind: EventRecord["kind"], payload: unknown): EventRecord => ({
      id,
      session_id: "s",
      ts: 0,
      kind,
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
    const events = [
      ev(1, "note", "起動: plyfold-mock-agent"),
      ev(2, "frame_out", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { prompt: [{ type: "text", text: "hi" }] } }),
      ev(3, "frame_in", { jsonrpc: "2.0", method: "session/update", params: { update: chunk("user_message_chunk", "hi") } }),
      ev(4, "frame_in", { jsonrpc: "2.0", method: "session/update", params: { update: chunk("agent_message_chunk", "echo: hi") } }),
      ev(5, "frame_in", { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 4 } } }),
      ev(6, "note", "session/load で開き直しました"),
      // 開き直しで再送された履歴（ターンの外なので user も出す）
      ev(7, "frame_in", { jsonrpc: "2.0", method: "session/update", params: { update: chunk("user_message_chunk", "old") } }),
    ];
    const t = fromHistory(events);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "agent", "stats", "notice", "user"]);
    const stats = t.items[2];
    if (stats.kind === "stats") expect(stats.stats?.usage?.input).toBe(100);
  });
});
