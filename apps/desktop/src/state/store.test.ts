import { describe, expect, it } from "vitest";

import type { SessionInfo, SessionRecord } from "@/lib/types";
import { reduceEvent, restoreLayout, type SessionView } from "./store";

const record: SessionRecord = {
  id: "s1",
  title: "t",
  profile: "mock",
  agent: "mock",
  repo_path: "/r",
  worktree_path: null,
  branch: null,
  base_ref: null,
  acp_session_id: null,
  status: "starting",
  created_at: 0,
  updated_at: 0,
};

const info = (tps: number): SessionInfo => ({
  config: [],
  modes: [],
  current_mode: null,
  context_used: 10,
  context_size: 100,
  cost: null,
  reported_model: null,
  last_turn: { usage: null, elapsed_ms: 1000, ttft_ms: 100, tokens_per_sec: tps, estimated: false },
  total: { input: 0, output: 0, cached_read: 0, cached_write: 0, thought: 0, total: 0 },
  live: null,
});

describe("reduceEvent", () => {
  it("runs a whole turn with a permission request", () => {
    let s: Record<string, SessionView> = reduceEvent({}, { type: "session_created", session: record });
    s = reduceEvent(s, { type: "status", session_id: "s1", status: "working" });
    s = reduceEvent(s, {
      type: "permission_requested",
      session_id: "s1",
      permission_id: "p1",
      title: "Write",
      tool_call: {},
      options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
    });
    expect(s.s1.permission?.permissionId).toBe("p1");
    s = reduceEvent(s, { type: "permission_resolved", session_id: "s1", permission_id: "p1", option_id: "allow" });
    expect(s.s1.permission).toBeNull();
    s = reduceEvent(s, { type: "update", session_id: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
    // Info はターン終了より先に届く。ターン終了の数値はそれを使う
    s = reduceEvent(s, { type: "info", session_id: "s1", info: info(42) });
    s = reduceEvent(s, { type: "turn_ended", session_id: "s1", stop_reason: "end_turn", error: null });
    const last = s.s1.transcript.items[s.s1.transcript.items.length - 1];
    expect(last.kind).toBe("stats");
    if (last.kind === "stats") expect(last.stats?.tokens_per_sec).toBe(42);
    expect(s.s1.record.status).toBe("working");
  });

  it("ignores events for unknown sessions and hides launch notices", () => {
    const s = reduceEvent({}, { type: "notice", session_id: "nope", message: "x" });
    expect(s).toEqual({});
    let t: Record<string, SessionView> = reduceEvent({}, { type: "session_created", session: record });
    t = reduceEvent(t, { type: "notice", session_id: "s1", message: "起動: npx …" });
    t = reduceEvent(t, { type: "notice", session_id: "s1", message: "120 秒間、エージェントから何も届いていません" });
    expect(t.s1.transcript.items).toEqual([{ kind: "notice", text: "120 秒間、エージェントから何も届いていません" }]);
  });
});

describe("restoreLayout", () => {
  it("keeps sessions that still exist and drops drafts and removed ones", () => {
    const l = restoreLayout({ panes: ["a", "gone", "draft:1", "b"], paneCount: 4, focusedPane: 3 }, (id) => id === "a" || id === "b");
    expect(l).toEqual({ panes: ["a", null, null, "b"], paneCount: 4, focusedPane: 3 });
  });

  it("rejects broken data and clamps the focused pane", () => {
    expect(restoreLayout(null, () => true)).toBeNull();
    expect(restoreLayout({ panes: [], paneCount: 3 }, () => true)).toBeNull();
    expect(restoreLayout({ panes: ["a"], paneCount: 1, focusedPane: 2 }, () => true)?.focusedPane).toBe(0);
  });
});
