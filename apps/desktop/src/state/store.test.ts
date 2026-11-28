import { describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

import type { SessionInfo, SessionRecord } from "@/lib/types";
import { preset } from "./layout";
import { defaultProfile, modeIds, reduceEvent, restoreLayout, useStore, type SessionView } from "./store";

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

describe("side chat", () => {
  it("keeps the conversation when hidden and reopens it", async () => {
    const sideRecord = { ...record, id: "side", side_of: "main", review: false, status: "idle" as const };
    const side = reduceEvent({}, { type: "session_created", session: sideRecord }).side;
    side.transcript = { ...side.transcript, items: [{ kind: "user", text: "question" }] };
    useStore.setState({ sessions: { side }, sideChats: { main: { id: "side", openedAt: 1, error: null } }, queues: {} });
    const open = vi.spyOn(api, "openSideChat");
    const close = vi.spyOn(api, "closeSideChat");
    const info = vi.spyOn(api, "sessionInfo").mockResolvedValue(null);

    await useStore.getState().closeSideChat("main");
    expect(useStore.getState().sessions.side.transcript.items).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    await useStore.getState().openSideChat("main");
    expect(useStore.getState().sideChats.main.id).toBe("side");
    expect(useStore.getState().sessions.side.transcript.items).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();

    open.mockRestore();
    close.mockRestore();
    info.mockRestore();
  });
});

describe("saved effort", () => {
  it("keeps a session's choice when another session changes the profile default", async () => {
    const saved = useStore.getState().effort;
    const session = { ...record, status: "idle" as const };
    const other = { ...session, id: "s2" };
    useStore.setState({
      sessions: reduceEvent(reduceEvent({}, { type: "session_created", session }), { type: "session_created", session: other }),
      effort: { profiles: {}, sessions: {} },
    });
    const change = vi.spyOn(api, "setByCategory").mockResolvedValue();
    const reopen = vi.spyOn(api, "reopenSession").mockResolvedValue();
    const sessionInfo = vi.spyOn(api, "sessionInfo").mockResolvedValue({
      ...info(0),
      config: [{ id: "effort", category: "thought_level", name: "Effort", current: "low", choices: [{ value: "high", name: "High" }] }],
    });
    try {
      const store = useStore.getState();
      await store.setCategory("s1", "thought_level", "high");
      await store.setCategory("s2", "thought_level", "low");
      expect(useStore.getState().effort.profiles.mock).toBe("low");
      change.mockClear();
      await store.reopen("s1");
      expect(change).toHaveBeenCalledWith("s1", "thought_level", "high");
    } finally {
      change.mockRestore();
      reopen.mockRestore();
      sessionInfo.mockRestore();
      useStore.setState({ effort: saved });
    }
  });
});

it("opens the new session pane while the agent is still starting", async () => {
  const draftId = "draft:early-start";
  const recordStarting = { ...record, id: "early" };
  const original = useStore.getState();
  useStore.setState({
    panes: [draftId, null],
    drafts: { [draftId]: { profile: "mock", repo: "/repo", chat: false, worktree: false, choices: {}, busy: false, error: null } },
    sessions: {},
    effort: { profiles: {}, sessions: {} },
  });
  let finish!: (record: SessionRecord) => void;
  const start = vi.spyOn(api, "startSession").mockImplementation((_args, created) => {
    created?.(recordStarting);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const prompt = vi.spyOn(api, "prompt").mockResolvedValue();
  try {
    const opening = useStore.getState().startDraft(draftId, "Hello");
    expect(useStore.getState().panes[0]).toBe("early");
    expect(useStore.getState().sessions.early.sendingFirstPrompt).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    finish({ ...recordStarting, status: "idle" });
    await opening;
    expect(prompt).toHaveBeenCalledWith("early", "Hello", []);
    expect(useStore.getState().sessions.early.sendingFirstPrompt).toBe(false);
  } finally {
    prompt.mockRestore();
    start.mockRestore();
    useStore.setState({ panes: original.panes, drafts: original.drafts, sessions: original.sessions, effort: original.effort });
  }
});

describe("rerunSession", () => {
  const source: SessionRecord = { ...record, id: "src", title: "Add a flag", repo_path: "/repo", worktree_path: "/wt/src", status: "idle", run_group: null };

  const setup = (over: Partial<SessionRecord> = {}, items: SessionView["transcript"]["items"] = [{ kind: "user", text: "add a flag" }]) => {
    const original = useStore.getState();
    const view = { ...original.sessions.s1, record: { ...source, ...over }, transcript: { inTurn: false, items }, historyLoaded: true } as SessionView;
    useStore.setState({ sessions: { src: view }, panes: ["src", null], effort: { profiles: {}, sessions: {} } });
    return () => useStore.setState({ panes: original.panes, sessions: original.sessions, effort: original.effort, layout: original.layout });
  };

  it("runs the first instruction again in a new worktree, in a run group with the original", async () => {
    const restore = setup();
    const groups: [string, string | null][] = [];
    vi.spyOn(api, "setRunGroup").mockImplementation(async (id, group) => {
      groups.push([id, group]);
      return { ...source, id, run_group: group };
    });
    const start = vi.spyOn(api, "startSession").mockResolvedValue({ ...source, id: "again", profile: "codex", status: "idle", worktree_path: "/wt/again" });
    vi.spyOn(api, "sessionInfo").mockResolvedValue(null);
    const prompt = vi.spyOn(api, "prompt").mockResolvedValue();
    try {
      await useStore.getState().rerunSession("src", "codex");
      expect(start).toHaveBeenCalledWith({ profile: "codex", repo: "/repo", title: "Add a flag", worktree: true });
      expect(prompt).toHaveBeenCalledWith("again", "add a flag", []);
      // Both are in the same group, which is what the comparison pane lists
      expect(groups.map(([id]) => id)).toEqual(["src", "again"]);
      expect(groups[0][1]).toBe(groups[1][1]);
      expect(groups[0][1]).toBeTruthy();
      expect(useStore.getState().sessions.src.record.run_group).toBe(groups[0][1]);
      expect(useStore.getState().panes.some((p) => p === `compare:${groups[0][1]}`)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      restore();
    }
  });

  it("joins the run group the session already has", async () => {
    const restore = setup({ run_group: "g" });
    const groups: (string | null)[] = [];
    vi.spyOn(api, "setRunGroup").mockImplementation(async (id, group) => {
      groups.push(group);
      return { ...source, id, run_group: group };
    });
    vi.spyOn(api, "startSession").mockResolvedValue({ ...source, id: "again", status: "idle" });
    vi.spyOn(api, "sessionInfo").mockResolvedValue(null);
    vi.spyOn(api, "prompt").mockResolvedValue();
    try {
      await useStore.getState().rerunSession("src", "codex");
      expect(groups).toEqual(["g"]);
    } finally {
      vi.restoreAllMocks();
      restore();
    }
  });

  it("refuses a session without a worktree or a first instruction, starting nothing", async () => {
    const start = vi.spyOn(api, "startSession").mockResolvedValue(source);
    try {
      let restore = setup({ worktree_path: null });
      await expect(useStore.getState().rerunSession("src", "codex")).rejects.toThrow();
      restore();
      restore = setup({}, []);
      await expect(useStore.getState().rerunSession("src", "codex")).rejects.toThrow();
      restore();
      expect(start).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("modeIds", () => {
  it("reads the mode option, else the legacy mode list", () => {
    const choice = (value: string) => ({ value, name: value, description: null });
    const withOption = { config: [{ category: "mode", choices: [choice("plan")] }], modes: [choice("old")] };
    const legacy = { config: [], modes: [choice("default"), choice("plan")] };
    expect(modeIds(withOption as never)).toEqual(["plan"]);
    expect(modeIds(legacy as never)).toEqual(["default", "plan"]);
    expect(modeIds(null)).toEqual([]);
  });
});

describe("closing a pane", () => {
  const view = (id: string): SessionView => ({ ...(reduceEvent({}, { type: "session_created", session: { ...record, id } })[id] as SessionView) });
  const setup = (focused: number) => {
    useStore.setState({
      layout: preset(4),
      panes: ["a", "b", "c", "d"],
      focusedPane: focused,
      paneCount: 4,
      composerInsert: null,
      sessions: { a: view("a"), b: view("b"), c: view("c"), d: view("d") },
      sideChats: {},
      drafts: {},
      previews: {},
    });
  };

  it("moves the focus to the pane before it, and asks for the cursor there", () => {
    setup(2);
    useStore.getState().closePane(2);
    const s = useStore.getState();
    expect(s.panes[s.focusedPane]).toBe("b");
    expect(s.composerInsert).toMatchObject({ scope: "b", text: "" });
  });

  it("falls to the pane after it when it was the first", () => {
    setup(0);
    useStore.getState().removePane(0);
    const s = useStore.getState();
    expect(s.panes[s.focusedPane]).toBe("b");
  });

  it("keeps the focus when another pane closes", () => {
    setup(3);
    useStore.getState().closePane(1);
    const s = useStore.getState();
    expect(s.panes[s.focusedPane]).toBe("d");
    expect(s.composerInsert).toBeNull();
  });
});

describe("a new session", () => {
  it("is brought forward, not opened again, when one is already open", () => {
    useStore.setState({ layout: preset(2), panes: [null, null, null, null], focusedPane: 0, drafts: {}, composerInsert: null, previews: {} });
    useStore.getState().newDraft();
    const first = Object.keys(useStore.getState().drafts);
    expect(first).toHaveLength(1);
    useStore.setState({ focusedPane: 1 });
    useStore.getState().newDraft();
    expect(Object.keys(useStore.getState().drafts)).toEqual(first);
    const s = useStore.getState();
    expect(s.panes[s.focusedPane]).toBe(first[0]);
  });
});

describe("starting a parallel comparison", () => {
  it("applies each profile's own model and effort to its own session", async () => {
    const original = useStore.getState();
    const draftId = "draft:parallel";
    useStore.setState({
      panes: [draftId, null],
      drafts: {
        [draftId]: {
          profile: "claude",
          repo: "/repo",
          chat: false,
          worktree: true,
          choices: {},
          compare: ["claude", "codex"],
          compareChoices: { claude: { model: "opus" }, codex: { model: "gpt-x", thought_level: "high" } },
          busy: false,
          error: null,
        },
      },
      sessions: {},
      effort: { profiles: {}, sessions: {} },
    });
    vi.spyOn(api, "startSession").mockImplementation(async ({ profile }) => ({
      ...record,
      id: `s-${profile}`,
      profile,
      agent: profile,
      status: "idle",
      worktree_path: `/wt/${profile}`,
    }));
    vi.spyOn(api, "setRunGroup").mockImplementation(async (id) => ({ ...record, id, profile: id.slice(2), agent: id.slice(2), status: "idle" }));
    vi.spyOn(api, "sessionInfo").mockImplementation(async () => ({
      ...info(0),
      config: [
        {
          id: "model",
          category: "model",
          name: "Model",
          current: "default",
          choices: [
            { value: "opus", name: "Opus" },
            { value: "gpt-x", name: "GPT X" },
          ],
        },
        {
          id: "effort",
          category: "thought_level",
          name: "Effort",
          current: "low",
          choices: [
            { value: "high", name: "High" },
            { value: "low", name: "Low" },
          ],
        },
      ],
    }));
    const change = vi.spyOn(api, "setByCategory").mockResolvedValue();
    vi.spyOn(api, "prompt").mockResolvedValue();
    try {
      await useStore.getState().startCompare(draftId, "do it");
      const calls = change.mock.calls.map((c) => c.join(":"));
      expect(calls).toContain("s-claude:model:opus");
      expect(calls).toContain("s-codex:model:gpt-x");
      expect(calls).toContain("s-codex:thought_level:high");
      // The first profile's choice is not copied to the others
      expect(calls).not.toContain("s-codex:model:opus");
      expect(calls).not.toContain("s-claude:thought_level:high");
      // Both sessions are open in panes (the draft is gone)
      const shown = useStore.getState().panes;
      expect(shown).toContain("s-claude");
      expect(shown).toContain("s-codex");
      expect(shown).not.toContain(draftId);
    } finally {
      vi.restoreAllMocks();
      useStore.setState({ panes: original.panes, drafts: original.drafts, sessions: original.sessions, effort: original.effort, layout: original.layout });
    }
  });
});
