// 画面の状態。エンジンのイベントをここで受けて、セッションごとの表示用の形にする

import { create } from "zustand";

import type { Look, LiquidStyle } from "@/components/liquid/liquid";
import { liquidCloseFrom, liquidOpen } from "@/components/liquid/stage";
import { api, inTauri, onEngineEvent } from "@/lib/api";
import { loadInfoCache, saveInfoCache, snapshot, type InfoCache } from "./infoCache";
import type { AppSettings, Category, SessionStatus, EngineEvent, ProfileSummary, SessionInfo, SessionRecord } from "@/lib/types";
import {
  addNotice,
  applyUpdate,
  beginTurn,
  emptyTranscript,
  endTurn,
  fromHistory,
  type PendingPermission,
  type Transcript,
} from "./transcript";

export interface SessionView {
  record: SessionRecord;
  info: SessionInfo | null;
  transcript: Transcript;
  permission: PendingPermission | null;
  /** 記録から会話を読み込んだか */
  historyLoaded: boolean;
  lastError: string | null;
  /** エージェントが動いていないあいだに選んだ model / effort / mode（次に起動した直後に設定する） */
  pending: Partial<Record<Category, string>>;
}

export type PaneCount = 1 | 2 | 4;

/** まだ始めていないセッション（ペインに空の状態で開く） */
export interface Draft {
  profile: string | null;
  repo: string;
  worktree: boolean;
  /** 起動前に選んだ model / effort / mode（起動した直後に設定する） */
  choices: Partial<Record<Category, string>>;
  busy: boolean;
  error: string | null;
}

export const isDraft = (id: string | null | undefined): id is string => !!id && id.startsWith("draft:");

/** ペインの見た目（分離アニメーションの行き先） */
const PANE_LOOK: Look = { background: "rgba(10, 10, 10, 1)", border: "rgba(255, 255, 255, 0.1)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
const settingsEl = () => document.querySelector<HTMLElement>("[data-settings-view]");
const profilesEl = () => document.querySelector<HTMLElement>("[data-profiles-view]");
const diffEl = () => document.querySelector<HTMLElement>("[data-diff-view]");
const paneEl = (i: number) => document.querySelector<HTMLElement>(`[data-pane-index="${i}"]`);
const anchorOf = (id: string) => (isDraft(id) ? "new-session" : `session:${id}`);
const LAST_REPO_KEY = "plyfold.lastRepo";
function lastRepo(): string {
  try {
    return localStorage.getItem(LAST_REPO_KEY) ?? "~/projects";
  } catch {
    return "~/projects";
  }
}

interface State {
  sessions: Record<string, SessionView>;
  drafts: Record<string, Draft>;
  profiles: ProfileSummary[];
  panes: (string | null)[];
  paneCount: PaneCount;
  focusedPane: number;
  searchOpen: boolean;
  labOpen: boolean;
  /** 分離アニメーションの型（動きの調整で選ぶ） */
  liquidStyle: LiquidStyle;
  /** 検索カードの分離アニメーションが動いているか（サイドバーを実体より手前に出す） */
  searchLayerActive: boolean;
  /** 分離アニメーションの「大きさの遅れ」（秒） */
  liquidLag: number;
  ready: boolean;

  init: () => Promise<void>;
  setPaneCount: (n: PaneCount) => void;
  /** from を渡すと、その出発点から分離アニメーションで開く */
  openInPane: (id: string, pane?: number, from?: string) => Promise<void>;
  /** 新しいセッションの下書きを、空いているペインに開く */
  newDraft: () => void;
  updateDraft: (id: string, patch: Partial<Draft>) => void;
  /** 下書きを本物のセッションとして始める（同じペインのまま入れ替わる） */
  startDraft: (id: string, prompt: string) => Promise<void>;
  closePane: (pane: number) => void;
  /** 差分の画面。closing のあいだは、縮む動きのために画面を残しておく */
  diff: { id: string; closing: boolean } | null;
  openDiff: (id: string) => void;
  /** worktree を操作したら増やす（ペインの差分の数を取り直すため） */
  diffVersion: number;
  bumpDiff: () => void;
  closeDiff: () => void;
  /** プロファイルの画面（差分と同じく、閉じる動きのあいだは残す） */
  profilesView: { closing: boolean } | null;
  settingsView: { closing: boolean } | null;
  /** プロファイルごとの、前回のセッションの設定項目（下書きで使う） */
  infoCache: InfoCache;
  openSettings: () => void;
  closeSettings: () => void;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  reloadSessions: () => Promise<void>;
  openProfiles: () => void;
  closeProfiles: () => void;
  refreshProfiles: () => Promise<void>;
  focusPane: (pane: number) => void;
  setSearchOpen: (open: boolean) => void;
  setLabOpen: (open: boolean) => void;
  setLiquidStyle: (s: LiquidStyle) => void;
  setSearchLayerActive: (v: boolean) => void;
  setLiquidLag: (v: number) => void;
  startSession: (args: { profile: string; repo: string; title: string; worktree: boolean; prompt?: string }) => Promise<void>;
  sendPrompt: (id: string, text: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  respondPermission: (id: string, optionId: string | null) => Promise<void>;
  setCategory: (id: string, category: Category, value: string) => Promise<void>;
  reopen: (id: string) => Promise<void>;
}

const newView = (record: SessionRecord): SessionView => ({
  record,
  info: null,
  transcript: emptyTranscript(),
  permission: null,
  historyLoaded: false,
  lastError: null,
  pending: {},
});

/** 起動した直後に、選んでおいた model / effort / mode を設定する（同じ値なら送らない） */
async function applyChoices(id: string, choices: Partial<Record<Category, string>>) {
  const wanted = Object.entries(choices) as [Category, string][];
  if (wanted.length === 0) return;
  const info = await api.sessionInfo(id);
  for (const [cat, value] of wanted) {
    const opt = info?.config.find((o) => o.category === cat);
    const cur = cat === "mode" ? (opt?.current ?? info?.current_mode) : opt?.current;
    if (cur === value) continue;
    await api.setByCategory(id, cat, value).catch(() => {
      // 候補が変わっていた場合などは、エージェントの既定のまま始める
    });
  }
}

const RUNNING: SessionStatus[] = ["idle", "working", "awaiting_permission", "stalled"];

/** エンジンのイベントを状態に反映する（副作用なし） */
export function reduceEvent(sessions: Record<string, SessionView>, e: EngineEvent): Record<string, SessionView> {
  if (e.type === "session_created") {
    return { ...sessions, [e.session.id]: { ...newView(e.session), historyLoaded: true } };
  }
  const id = e.session_id;
  const v = sessions[id];
  if (!v) return sessions;
  const next = { ...v };
  switch (e.type) {
    case "status":
      next.record = { ...v.record, status: e.status, updated_at: Date.now() };
      break;
    case "update":
      next.transcript = applyUpdate(v.transcript, e.update);
      break;
    case "permission_requested":
      next.permission = { permissionId: e.permission_id, title: e.title, toolCall: e.tool_call, options: e.options };
      break;
    case "permission_resolved":
      if (v.permission?.permissionId === e.permission_id) next.permission = null;
      break;
    case "turn_ended":
      next.transcript = endTurn(v.transcript, v.info?.last_turn ?? null, e.stop_reason, e.error);
      next.permission = null;
      break;
    case "notice":
      if (!e.message.startsWith("起動:")) next.transcript = addNotice(v.transcript, e.message);
      break;
    case "info":
      next.info = e.info;
      break;
  }
  return { ...sessions, [id]: next };
}

export const useStore = create<State>((set, get) => ({
  sessions: {},
  drafts: {},
  profiles: [],
  panes: [null, null, null, null],
  paneCount: 2,
  focusedPane: 0,
  searchOpen: false,
  labOpen: false,
  diff: null,
  diffVersion: 0,
  bumpDiff: () => set((s) => ({ diffVersion: s.diffVersion + 1 })),
  profilesView: null,
  settingsView: null,
  infoCache: loadInfoCache(),
  settings: { editor: "auto", cleanup_after_merge: false, stall_seconds: 120, worktree_default: true },
  liquidStyle: "pop",
  searchLayerActive: false,
  liquidLag: 0.12,
  ready: false,

  init: async () => {
    if (!inTauri || get().ready) return;
    await onEngineEvent((e) => set((s) => ({ sessions: reduceEvent(s.sessions, e) })));
    const [profiles, records, sv] = await Promise.all([api.listProfiles(), api.listSessions(), api.getSettings()]);
    const sessions: Record<string, SessionView> = {};
    for (const r of records) sessions[r.id] = newView(r);
    set({ profiles, sessions, settings: sv.settings, ready: true });
  },

  setPaneCount: (paneCount) => set((s) => ({ paneCount, focusedPane: Math.min(s.focusedPane, paneCount - 1) })),

  openInPane: async (id, pane, from) => {
    const s = get();
    const already = s.panes.slice(0, s.paneCount).indexOf(id);
    if (already >= 0) {
      set({ focusedPane: already });
    } else {
      const target = pane ?? firstFreePane(s.panes, s.paneCount, s.focusedPane);
      const panes = [...s.panes];
      const displaced = panes[target];
      panes[target] = id;
      // 入れ替えられたセッションは、ペインから縮んで元の場所（サイドバーの行）の裏へ戻る
      if (displaced) liquidCloseFrom(`pane-${target}-out`, { anchor: anchorOf(displaced), target: () => paneEl(target), toLook: PANE_LOOK });
      // 入れ替えのときは、戻る動きが出たのを見てから飛び出す（すれ違いを少しずらす）
      if (from) liquidOpen(`pane-${target}`, { anchor: from, target: () => paneEl(target), toLook: PANE_LOOK, delay: displaced ? 140 : 0 });
      const drafts = { ...s.drafts };
      if (isDraft(displaced)) delete drafts[displaced!];
      set({ panes, focusedPane: target, drafts });
    }
    if (isDraft(id)) return;
    // 止まっているセッションは、記録から会話を読み込む
    const v = get().sessions[id];
    if (v && !v.historyLoaded) {
      const events = await api.sessionHistory(id);
      set((st) => ({
        sessions: { ...st.sessions, [id]: { ...st.sessions[id], transcript: fromHistory(events), historyLoaded: true } },
      }));
    }
    if (v && v.info === null) {
      const info = await api.sessionInfo(id);
      if (info) set((st) => ({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], info } } }));
    }
  },

  openDiff: (id) => {
    // 差分の画面は、ペインの差分の数（+12 −3）から飛び出して広がる
    liquidOpen("diff", { cover: true, anchor: `diff:${id}`, target: diffEl, toLook: PANE_LOOK });
    set({ diff: { id, closing: false } });
  },

  closeDiff: () => {
    const d = get().diff;
    if (!d || d.closing) return;
    set({ diff: { ...d, closing: true } });
    liquidCloseFrom("diff", { cover: true, anchor: `diff:${d.id}`, target: diffEl, toLook: PANE_LOOK, onDone: () => set({ diff: null }) });
  },

  openProfiles: () => {
    if (get().profilesView) return;
    liquidOpen("profiles", { cover: true, anchor: "profiles", target: profilesEl, toLook: PANE_LOOK });
    set({ profilesView: { closing: false } });
  },

  closeProfiles: () => {
    const v = get().profilesView;
    if (!v || v.closing) return;
    set({ profilesView: { closing: true } });
    liquidCloseFrom("profiles", { cover: true, anchor: "profiles", target: profilesEl, toLook: PANE_LOOK, onDone: () => set({ profilesView: null }) });
  },

  openSettings: () => {
    if (get().settingsView) return;
    liquidOpen("settings", { cover: true, anchor: "settings", target: settingsEl, toLook: PANE_LOOK });
    set({ settingsView: { closing: false } });
  },

  closeSettings: () => {
    const v = get().settingsView;
    if (!v || v.closing) return;
    set({ settingsView: { closing: true } });
    liquidCloseFrom("settings", { cover: true, anchor: "settings", target: settingsEl, toLook: PANE_LOOK, onDone: () => set({ settingsView: null }) });
  },

  saveSettings: async (patch) => {
    const prev = get().settings;
    const next = { ...prev, ...patch };
    set({ settings: next });
    try {
      await api.saveSettings(next);
    } catch (e) {
      set({ settings: prev });
      throw e;
    }
  },

  reloadSessions: async () => {
    const records = await api.listSessions();
    set((st) => {
      const sessions = { ...st.sessions };
      for (const r of records) sessions[r.id] = sessions[r.id] ? { ...sessions[r.id], record: r } : newView(r);
      return { sessions };
    });
  },

  refreshProfiles: async () => {
    if (!inTauri) return;
    set({ profiles: await api.listProfiles() });
  },

  closePane: (pane) => {
    const id = get().panes[pane];
    // 閉じるときは、ペインから縮んで出発点（サイドバーの行）の裏へ戻る
    if (id) liquidCloseFrom(`pane-${pane}`, { anchor: anchorOf(id), target: () => paneEl(pane), toLook: PANE_LOOK });
    set((s) => {
      const panes = [...s.panes];
      panes[pane] = null;
      const drafts = { ...s.drafts };
      if (isDraft(id)) delete drafts[id];
      return { panes, drafts };
    });
  },

  newDraft: () => {
    const s = get();
    const id = `draft:${Date.now()}`;
    const named = s.profiles.find((p) => p.name !== p.agent) ?? s.profiles[0];
    set({ drafts: { ...s.drafts, [id]: { profile: named?.name ?? null, repo: lastRepo(), worktree: s.settings.worktree_default, choices: {}, busy: false, error: null } } });
    void get().openInPane(id, undefined, "new-session");
  },

  updateDraft: (id, patch) => set((s) => (s.drafts[id] ? { drafts: { ...s.drafts, [id]: { ...s.drafts[id], ...patch } } } : s)),

  startDraft: async (id, prompt) => {
    const d = get().drafts[id];
    if (!d?.profile || d.busy) return;
    get().updateDraft(id, { busy: true, error: null });
    try {
      try {
        localStorage.setItem(LAST_REPO_KEY, d.repo);
      } catch {
        // 保存できなくても続ける
      }
      const title = prompt.trim().split("\n")[0].slice(0, 40) || "新しいセッション";
      const rec = await api.startSession({ profile: d.profile, repo: d.repo, title, worktree: d.worktree });
      // 下書きで選んだ model / effort / mode を、最初のプロンプトの前に設定する
      await applyChoices(rec.id, d.choices);
      set((s) => {
        const panes = s.panes.map((p) => (p === id ? rec.id : p));
        const drafts = { ...s.drafts };
        delete drafts[id];
        const sessions = s.sessions[rec.id] ? s.sessions : { ...s.sessions, [rec.id]: { ...newView(rec), historyLoaded: true } };
        return { panes, drafts, sessions };
      });
      if (prompt.trim()) await get().sendPrompt(rec.id, prompt);
    } catch (e) {
      get().updateDraft(id, { busy: false, error: String(e) });
    }
  },

  focusPane: (focusedPane) => set({ focusedPane }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setLabOpen: (labOpen) => set({ labOpen }),
  setLiquidStyle: (liquidStyle) => set({ liquidStyle }),
  setSearchLayerActive: (searchLayerActive) => set({ searchLayerActive }),
  setLiquidLag: (liquidLag) => set({ liquidLag }),

  startSession: async ({ prompt, ...args }) => {
    const rec = await api.startSession(args);
    await get().openInPane(rec.id);
    if (prompt?.trim()) await get().sendPrompt(rec.id, prompt);
  },

  sendPrompt: async (id, text) => {
    set((s) => {
      const v = s.sessions[id];
      return { sessions: { ...s.sessions, [id]: { ...v, transcript: beginTurn(v.transcript, text), lastError: null } } };
    });
    try {
      // 止まっているセッションは、送る前に開き直す
      const status = get().sessions[id]?.record.status;
      if (status === "closed" || status === "error") {
        await api.reopenSession(id);
        const pending = get().sessions[id]?.pending ?? {};
        await applyChoices(id, pending);
        set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id], pending: {} } } } : s));
      }
      await api.prompt(id, text);
    } catch (err) {
      set((s) => {
        const v = s.sessions[id];
        return {
          sessions: {
            ...s.sessions,
            [id]: { ...v, transcript: endTurn(v.transcript, null, null, String(err)), lastError: String(err) },
          },
        };
      });
    }
  },

  cancel: async (id) => {
    await api.cancel(id);
  },

  respondPermission: async (id, optionId) => {
    const p = get().sessions[id]?.permission;
    if (!p) return;
    await api.respondPermission(id, p.permissionId, optionId);
  },

  setCategory: async (id, category, value) => {
    const v = get().sessions[id];
    // 動いていなければ覚えておき、次に起動した直後に設定する
    if (v && !RUNNING.includes(v.record.status)) {
      set((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], pending: { ...s.sessions[id].pending, [category]: value } } } }));
      return;
    }
    await api.setByCategory(id, category, value);
  },

  reopen: async (id) => {
    await api.reopenSession(id);
  },
}));

function firstFreePane(panes: (string | null)[], count: number, focused: number): number {
  const free = panes.slice(0, count).indexOf(null);
  return free >= 0 ? free : focused;
}

// セッションの設定項目が変わったら、プロファイルごとに覚えておく
useStore.subscribe((st, prev) => {
  if (st.sessions === prev.sessions) return;
  let next: InfoCache | null = null;
  for (const [id, v] of Object.entries(st.sessions)) {
    if (!v.info || v.info === prev.sessions[id]?.info || v.info.config.length === 0) continue;
    const snap = snapshot(v.info);
    const old = (next ?? st.infoCache)[v.record.profile];
    if (old && JSON.stringify(old) === JSON.stringify(snap)) continue;
    next = { ...(next ?? st.infoCache), [v.record.profile]: snap };
  }
  if (next) {
    useStore.setState({ infoCache: next });
    saveInfoCache(next);
  }
});
