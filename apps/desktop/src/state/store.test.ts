import { describe, expect, it } from "vitest";

import type { SessionInfo, SessionRecord } from "@/lib/types";
import { preset } from "./layout";
import { defaultProfile, reduceEvent, restoreLayout, useStore, type SessionView } from "./store";

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
    // Info arrives before the turn ends; the turn-end numbers use it
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
    const l = restoreLayout({ panes: ["a", "gone", "draft:1", "b"], layout: preset(4), focusedPane: 3 }, (id) => id === "a" || id === "b");
    expect(l?.panes).toEqual(["a", null, null, "b"]);
    expect(l?.layout).toEqual(preset(4));
    expect(l?.focusedPane).toBe(3);
    expect(l?.sidebarOpen).toBe(true);
  });

  it("reads older saves with a pane count, and rejects broken data", () => {
    const old = restoreLayout({ panes: ["a", "b"], paneCount: 2, focusedPane: 1, sidebarOpen: false, sidebarWidth: 9999 }, () => true);
    expect(old?.layout).toEqual(preset(2));
    expect(old?.sidebarOpen).toBe(false);
    expect(old?.sidebarWidth).toBe(420);
    expect(restoreLayout(null, () => true)).toBeNull();
    expect(restoreLayout({ panes: [], paneCount: 3 }, () => true)).toBeNull();
    // A focused slot that is not shown falls back to the first pane
    expect(restoreLayout({ panes: ["a"], layout: preset(1), focusedPane: 2 }, () => true)?.focusedPane).toBe(0);
  });
});

describe("renamed", () => {
  it("replaces the title when the agent names the session", () => {
    let s: Record<string, SessionView> = reduceEvent({}, { type: "session_created", session: record });
    s = reduceEvent(s, { type: "renamed", session_id: "s1", title: "リポジトリの概要" });
    expect(s.s1.record.title).toBe("リポジトリの概要");
  });
});

describe("defaultProfile", () => {
  const profiles = [
    { name: "claude", agent: "claude", label: "Claude Code", isolate: false, keyed: false, custom_provider: false },
    { name: "work", agent: "claude", label: "Claude Code", isolate: true, keyed: true, custom_provider: false },
    { name: "codex", agent: "codex", label: "Codex", isolate: false, keyed: false, custom_provider: false },
  ] as Parameters<typeof defaultProfile>[0];

  it("prefers the setting, then the last used profile, then the first named one", () => {
    expect(defaultProfile(profiles, "codex", "work")).toBe("codex");
    expect(defaultProfile(profiles, "", "codex")).toBe("codex");
    expect(defaultProfile(profiles, "", null)).toBe("work");
    // Profiles that no longer exist are skipped
    expect(defaultProfile(profiles, "gone", "gone-too")).toBe("work");
    expect(defaultProfile([], "", null)).toBeNull();
  });
});

describe("queue", () => {
  it("holds back a message being edited, and sends it once saved", () => {
    const view = reduceEvent({}, { type: "session_created", session: { ...record, status: "idle" } }).s1;
    useStore.setState({ sessions: { s1: view }, queues: { s1: [] } });
    const st = useStore.getState();
    st.enqueue("s1", "first", []);
    st.enqueue("s1", "second", []);
    const [a] = useStore.getState().queues.s1;
    st.editQueued("s1", a.key, true);
    // Idle, but the first message is being edited: nothing goes, in order
    useStore.getState().sendQueued("s1");
    expect(useStore.getState().queues.s1.map((q) => q.text)).toEqual(["first", "second"]);
    // Saving sends the edited text first
    useStore.getState().saveQueued("s1", a.key, "first, edited");
    expect(useStore.getState().queues.s1.map((q) => q.text)).toEqual(["second"]);
    const items = useStore.getState().sessions.s1.transcript.items;
    expect(items.some((i) => i.kind === "user" && i.text === "first, edited")).toBe(true);
  });
});
