// UI state. Engine events are received here and turned into a per-session view model

import { create } from "zustand";

import type { Look, LiquidStyle } from "@/components/liquid/liquid";
import { liquidCloseFrom, liquidOpen } from "@/components/liquid/stage";
import type { Attached } from "@/lib/attachments";
import { resolveLang, setLang, t } from "@/i18n";
import { api, inTauri, onEngineEvent } from "@/lib/api";
import { notify } from "@/lib/notify";
import { loadInfoCache, saveInfoCache, snapshot, type InfoCache } from "./infoCache";
import type { AppSettings, Category, SessionStatus, EngineEvent, ProfileSummary, ProfileUsage, SessionInfo, SessionRecord } from "@/lib/types";
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
  /** Whether the conversation has been loaded from the log */
  historyLoaded: boolean;
  lastError: string | null;
  /** model / effort / mode chosen while the agent wasn't running (applied right after the next start) */
  pending: Partial<Record<Category, string>>;
}

export type PaneCount = 1 | 2 | 4;

/** A session not started yet (opens empty in a pane) */
export interface Draft {
  profile: string | null;
  repo: string;
  worktree: boolean;
  /** model / effort / mode chosen before starting (applied right after start) */
  choices: Partial<Record<Category, string>>;
  busy: boolean;
  error: string | null;
}

export const isDraft = (id: string | null | undefined): id is string => !!id && id.startsWith("draft:");
/** A pane showing a web page (a dev server the agent started, or any URL) */
export const isPreview = (id: string | null | undefined): id is string => !!id && id.startsWith("preview:");

export interface PreviewPage {
  url: string;
  /** liquidAnchor of the button it was opened from (the pane grows out of it and shrinks back into it) */
  anchor: string;
}

/** Pane appearance (the target of separation animations) */
const PANE_LOOK: Look = { background: "rgba(10, 10, 10, 1)", border: "rgba(255, 255, 255, 0.1)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
const settingsEl = () => document.querySelector<HTMLElement>("[data-settings-view]");
const profilesEl = () => document.querySelector<HTMLElement>("[data-profiles-view]");
const diffEl = () => document.querySelector<HTMLElement>("[data-diff-view]");
const paneEl = (i: number) => document.querySelector<HTMLElement>(`[data-pane-index="${i}"]`);
const anchorOf = (id: string) =>
  isDraft(id) ? "new-session" : isPreview(id) ? (useStore.getState().previews[id]?.anchor ?? "new-session") : `session:${id}`;
const LAST_REPO_KEY = "plyfold.lastRepo";
function lastRepo(): string {
  try {
    return localStorage.getItem(LAST_REPO_KEY) ?? "~/projects";
  } catch {
    return "~/projects";
  }
}

/** Set the UI language and tell the engine to use it too (for error and notice text) */
function applyLang(setting: AppSettings["language"] | undefined) {
  const lang = resolveLang(setting);
  setLang(lang);
  if (inTauri) void api.setUiLang(lang).catch(() => {});
}

/** Instruction sent mid-turn */
export interface Queued {
  key: string;
  text: string;
  attachments: Attached[];
}
let queueSeq = 0;

/** Engine event listener (only one per window, even if the store is reloaded during development) */
const engineListener = ((globalThis as { __plyfoldEngineListener?: { current: Promise<() => void> | null } }).__plyfoldEngineListener ??= { current: null });
let initStarted = false;

// Pane layout and the sessions shown in panes (restored at launch)
const LAYOUT_KEY = "plyfold.layout";
export interface Layout {
  panes: (string | null)[];
  paneCount: PaneCount;
  focusedPane: number;
  /** Where the panes are split: x is the left/right boundary, y the top/bottom one (0..1 of the pane area) */
  split: Split;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

/** Sidebar width bounds and default (px) */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 240;
const clampSidebar = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, v))) : SIDEBAR_DEFAULT);

export interface Split {
  x: number;
  y: number;
}
export const EVEN_SPLIT: Split = { x: 0.5, y: 0.5 };
const clampSplit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(0.85, Math.max(0.15, v)) : 0.5);

/** Restore the saved layout against current sessions (deleted sessions and drafts become empty panes) */
export function restoreLayout(saved: unknown, exists: (id: string) => boolean): Layout | null {
  if (!saved || typeof saved !== "object") return null;
  const o = saved as Partial<Layout>;
  const paneCount = o.paneCount === 1 || o.paneCount === 2 || o.paneCount === 4 ? o.paneCount : null;
  if (!paneCount || !Array.isArray(o.panes)) return null;
  const panes = [0, 1, 2, 3].map((i) => {
    const id = o.panes![i];
    return typeof id === "string" && !isDraft(id) && exists(id) ? id : null;
  });
  const focusedPane = typeof o.focusedPane === "number" && o.focusedPane >= 0 && o.focusedPane < paneCount ? o.focusedPane : 0;
  const split = { x: clampSplit(o.split?.x), y: clampSplit(o.split?.y) };
  const sidebarOpen = o.sidebarOpen !== false;
  return { panes, paneCount, focusedPane, split, sidebarOpen, sidebarWidth: clampSidebar(o.sidebarWidth) };
}

function readLayout(): unknown {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

interface State {
  sessions: Record<string, SessionView>;
  drafts: Record<string, Draft>;
  previews: Record<string, PreviewPage>;
  /** Open a web page in a pane (a free one, or one more pane), growing out of the given anchor */
  openPreview: (url: string, anchor: string) => void;
  setPreviewUrl: (id: string, url: string) => void;
  profiles: ProfileSummary[];
  panes: (string | null)[];
  paneCount: PaneCount;
  focusedPane: number;
  searchOpen: boolean;
  labOpen: boolean;
  /** Separation animation style (chosen in the motion lab) */
  liquidStyle: LiquidStyle;
  /** Whether the search card's separation animation is running (raises the sidebar above the blob) */
  searchLayerActive: boolean;
  /** Separation animation size lag (seconds) */
  liquidLag: number;
  ready: boolean;

  init: () => Promise<void>;
  setPaneCount: (n: PaneCount) => void;
  /** Pane split ratios (dragging the boundary between panes) */
  split: Split;
  setSplit: (patch: Partial<Split>) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  sidebarWidth: number;
  setSidebarWidth: (px: number) => void;
  /** True while the sidebar edge is being dragged (the width follows the pointer instead of springing) */
  sidebarResizing: boolean;
  /** With from, opens with a separation animation from that anchor */
  openInPane: (id: string, pane?: number, from?: string) => Promise<void>;
  /** Open a new session draft in a free pane */
  newDraft: () => void;
  /** Per-profile usage over the last 30 days (shown on the new session screen). null until fetched */
  usage: ProfileUsage[] | null;
  loadUsage: () => Promise<void>;
  updateDraft: (id: string, patch: Partial<Draft>) => void;
  /** Start a draft as a real session (swapped in place in the same pane) */
  startDraft: (id: string, prompt: string, attachments?: Attached[]) => Promise<void>;
  closePane: (pane: number) => void;
  /** Diff screen. Kept mounted while closing so it can shrink away */
  diff: { id: string; closing: boolean } | null;
  openDiff: (id: string) => void;
  /** Bumped after worktree operations (so panes refetch their diff counts) */
  diffVersion: number;
  bumpDiff: () => void;
  closeDiff: () => void;
  /** Profiles screen (kept mounted during the close animation, like the diff screen) */
  profilesView: { closing: boolean } | null;
  settingsView: { closing: boolean } | null;
  /** Per-profile config options from the last session (used by drafts) */
  infoCache: InfoCache;
  /** Sessions whose turn finished while unseen (cleared when opened in a pane). Value is the finish time */
  unread: Record<string, { at: number; error: boolean }>;
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
  sendPrompt: (id: string, text: string, attachments?: Attached[]) => Promise<void>;
  /** Instructions sent mid-turn (sent in order once the turn ends) */
  queues: Record<string, Queued[]>;
  enqueue: (id: string, text: string, attachments: Attached[]) => void;
  unqueue: (id: string, key: string) => void;
  /** Send the head of the queue now (no-op mid-turn) */
  sendQueued: (id: string) => void;
  cancel: (id: string) => Promise<void>;
  respondPermission: (id: string, optionId: string | null) => Promise<void>;
  setCategory: (id: string, category: Category, value: string) => Promise<void>;
  reopen: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** Stop the agent (the log and worktree remain) */
  stopSession: (id: string) => Promise<void>;
  /** Delete along with the log. With removeWorktree, also delete the worktree and branch */
  removeSession: (id: string, removeWorktree: boolean) => Promise<void>;
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

/** Right after start, apply the preselected model / effort / mode (skipped if unchanged) */
async function applyChoices(id: string, choices: Partial<Record<Category, string>>) {
  const wanted = Object.entries(choices) as [Category, string][];
  if (wanted.length === 0) return;
  const info = await api.sessionInfo(id);
  for (const [cat, value] of wanted) {
    const opt = info?.config.find((o) => o.category === cat);
    const cur = cat === "mode" ? (opt?.current ?? info?.current_mode) : opt?.current;
    if (cur === value) continue;
    await api.setByCategory(id, cat, value).catch(() => {
      // If the options changed, start with the agent's defaults
    });
  }
}

const RUNNING: SessionStatus[] = ["idle", "working", "awaiting_permission", "stalled"];

/** Apply an engine event to the state (pure) */
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
    case "renamed":
      next.record = { ...v.record, title: e.title };
      break;
  }
  return { ...sessions, [id]: next };
}

export const useStore = create<State>((set, get) => ({
  sessions: {},
  drafts: {},
  previews: {},
  openPreview: (url, anchor) => {
    const s = get();
    const id = `preview:${Date.now()}`;
    set({ previews: { ...s.previews, [id]: { url, anchor } } });
    // A free pane if there is one; otherwise one more pane (1 → 2 → 4); with four panes, the one after the focused pane
    // Missing entries count as free too (the panes array may be shorter than the pane count)
    const freeIn = (panes: (string | null)[], n: number) => Array.from({ length: n }, (_, i) => i).find((i) => !panes[i]) ?? -1;
    let count = s.paneCount;
    let target = freeIn(s.panes, count);
    if (target < 0 && count < 4) {
      count = count === 1 ? 2 : 4;
      set({ paneCount: count });
      target = freeIn(get().panes, count);
    }
    if (target < 0) target = (s.focusedPane + 1) % count;
    void get().openInPane(id, target, anchor);
  },
  setPreviewUrl: (id, url) => set((s) => (s.previews[id] ? { previews: { ...s.previews, [id]: { ...s.previews[id], url } } } : s)),
  profiles: [],
  panes: [null, null, null, null],
  paneCount: 2,
  split: EVEN_SPLIT,
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarResizing: false,
  focusedPane: 0,
  searchOpen: false,
  labOpen: false,
  diff: null,
  diffVersion: 0,
  bumpDiff: () => set((s) => ({ diffVersion: s.diffVersion + 1 })),
  profilesView: null,
  settingsView: null,
  infoCache: loadInfoCache(),
  unread: {},
  settings: { editor: "auto", cleanup_after_merge: false, stall_seconds: 120, worktree_default: true, send_key: "enter", language: "auto", sidebar_density: "comfortable" },
  liquidStyle: "pop",
  searchLayerActive: false,
  liquidLag: 0.12,
  ready: false,

  init: async () => {
    // StrictMode runs effects twice in development. ready is set only after loading, so mark it as started up front
    if (!inTauri || get().ready || initStarted) return;
    initStarted = true;
    // Only one listener per window. If the store is reloaded during development, remove the old one
    // (with two, every event arrives twice and message text gets doubled)
    const prev = engineListener.current;
    const next = onEngineEvent((e) => {
      // When a turn ends, send queued instructions (not after a cancel or error; they stay queued)
      if (e.type === "turn_ended" && !e.error && e.stop_reason !== "cancelled") queueMicrotask(() => get().sendQueued(e.session_id));
      set((s) => {
        const sessions = reduceEvent(s.sessions, e);
        // Also post a macOS notification when the app isn't in focus
        const title = s.sessions[(e as { session_id?: string }).session_id ?? ""]?.record.title ?? t("store.fallbackTitle");
        if (e.type === "permission_requested") notify(title, t("store.notifyPermission"));
        if (e.type === "turn_ended") notify(title, e.error ? t("store.notifyError", { error: e.error }) : t("store.notifyTurnEnded"));
        // Record turn ends as notifications for sessions not on screen (or when the app isn't in focus)
        if (e.type === "turn_ended") {
          const shown = s.panes.slice(0, s.paneCount).includes(e.session_id) && document.hasFocus();
          if (!shown) return { sessions, unread: { ...s.unread, [e.session_id]: { at: Date.now(), error: !!e.error } } };
        }
        return { sessions };
      });
    });
    engineListener.current = next;
    if (prev) void prev.then((off) => off());
    await next;
    const [profiles, records, sv] = await Promise.all([api.listProfiles(), api.listSessions(), api.getSettings()]);
    const sessions: Record<string, SessionView> = {};
    for (const r of records) sessions[r.id] = newView(r);
    // Restore the previous layout and the sessions shown in panes (without separation animations)
    const layout = restoreLayout(readLayout(), (id) => !!sessions[id]);
    applyLang(sv.settings.language);
    set({ profiles, sessions, settings: sv.settings, ready: true, ...(layout ?? {}) });
    for (const id of layout?.panes ?? []) if (id) void loadSession(id);
  },

  setPaneCount: (paneCount) => set((s) => ({ paneCount, focusedPane: Math.min(s.focusedPane, paneCount - 1) })),
  setSplit: (patch) => set((s) => ({ split: { x: clampSplit(patch.x ?? s.split.x), y: clampSplit(patch.y ?? s.split.y) } })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (px) => set({ sidebarWidth: clampSidebar(px) }),

  openInPane: async (id, pane, from) => {
    if (get().unread[id]) {
      const unread = { ...get().unread };
      delete unread[id];
      set({ unread });
    }
    const s = get();
    const already = s.panes.slice(0, s.paneCount).indexOf(id);
    if (already >= 0) {
      set({ focusedPane: already });
    } else {
      const target = pane ?? firstFreePane(s.panes, s.paneCount, s.focusedPane);
      const panes = [...s.panes];
      const displaced = panes[target];
      panes[target] = id;
      // A replaced session shrinks out of the pane back behind where it came from (its sidebar row)
      if (displaced) liquidCloseFrom(`pane-${target}-out`, { anchor: anchorOf(displaced), target: () => paneEl(target), toLook: PANE_LOOK });
      // When replacing, wait for the return animation to start before emerging (staggers the crossover slightly)
      if (from) liquidOpen(`pane-${target}`, { anchor: from, target: () => paneEl(target), toLook: PANE_LOOK, delay: displaced ? 140 : 0 });
      const drafts = { ...s.drafts };
      if (isDraft(displaced)) delete drafts[displaced!];
      const previews = { ...s.previews };
      if (isPreview(displaced)) delete previews[displaced!];
      set({ panes, focusedPane: target, drafts, previews });
    }
    if (isDraft(id) || isPreview(id)) return;
    await loadSession(id);
  },

  openDiff: (id) => {
    // The diff screen expands out of the pane's diff count (+12 −3)
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
    if (patch.language) applyLang(next.language);
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
    // On close, shrink out of the pane back behind the anchor (the sidebar row)
    if (id) liquidCloseFrom(`pane-${pane}`, { anchor: anchorOf(id), target: () => paneEl(pane), toLook: PANE_LOOK });
    set((s) => {
      const panes = [...s.panes];
      panes[pane] = null;
      const drafts = { ...s.drafts };
      if (isDraft(id)) delete drafts[id];
      const previews = { ...s.previews };
      if (isPreview(id)) delete previews[id];
      return { panes, drafts, previews };
    });
  },

  queues: {},
  enqueue: (id, text, attachments) =>
    set((s) => ({ queues: { ...s.queues, [id]: [...(s.queues[id] ?? []), { key: `q${++queueSeq}`, text, attachments }] } })),
  unqueue: (id, key) => set((s) => ({ queues: { ...s.queues, [id]: (s.queues[id] ?? []).filter((q) => q.key !== key) } })),
  sendQueued: (id) => {
    const s = get();
    const [next, ...rest] = s.queues[id] ?? [];
    if (!next || s.sessions[id]?.transcript.inTurn) return;
    set({ queues: { ...s.queues, [id]: rest } });
    void get().sendPrompt(id, next.text, next.attachments);
  },

  usage: null,
  loadUsage: async () => {
    if (!inTauri) return;
    try {
      set({ usage: await api.usageSummary(30) });
    } catch {
      // New sessions can start even if counting fails
    }
  },

  newDraft: () => {
    const s = get();
    const id = `draft:${Date.now()}`;
    const named = s.profiles.find((p) => p.name !== p.agent) ?? s.profiles[0];
    set({ drafts: { ...s.drafts, [id]: { profile: named?.name ?? null, repo: lastRepo(), worktree: s.settings.worktree_default, choices: {}, busy: false, error: null } } });
    void get().openInPane(id, undefined, "new-session");
  },

  updateDraft: (id, patch) => set((s) => (s.drafts[id] ? { drafts: { ...s.drafts, [id]: { ...s.drafts[id], ...patch } } } : s)),

  startDraft: async (id, prompt, attachments = []) => {
    const d = get().drafts[id];
    if (!d?.profile || d.busy) return;
    get().updateDraft(id, { busy: true, error: null });
    try {
      try {
        localStorage.setItem(LAST_REPO_KEY, d.repo);
      } catch {
        // Continue even if saving fails
      }
      const title = prompt.trim().split("\n")[0].slice(0, 40) || t("store.newSessionTitle");
      const rec = await api.startSession({ profile: d.profile, repo: d.repo, title, worktree: d.worktree });
      // Apply the model / effort / mode chosen in the draft before the first prompt
      await applyChoices(rec.id, d.choices);
      set((s) => {
        const panes = s.panes.map((p) => (p === id ? rec.id : p));
        const drafts = { ...s.drafts };
        delete drafts[id];
        const sessions = s.sessions[rec.id] ? s.sessions : { ...s.sessions, [rec.id]: { ...newView(rec), historyLoaded: true } };
        return { panes, drafts, sessions };
      });
      if (prompt.trim() || attachments.length) await get().sendPrompt(rec.id, prompt, attachments);
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

  sendPrompt: async (id, text, attachments = []) => {
    set((s) => {
      const v = s.sessions[id];
      const previews = attachments.map((a) => a.preview);
      return { sessions: { ...s.sessions, [id]: { ...v, transcript: beginTurn(v.transcript, text, previews), lastError: null } } };
    });
    try {
      // Reopen a stopped session before sending
      const status = get().sessions[id]?.record.status;
      if (status === "closed" || status === "error") {
        await api.reopenSession(id);
        const pending = get().sessions[id]?.pending ?? {};
        await applyChoices(id, pending);
        set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id], pending: {} } } } : s));
      }
      await api.prompt(id, text, attachments.map((a) => a.wire));
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
    // If not running, remember it and apply right after the next start
    if (v && !RUNNING.includes(v.record.status)) {
      set((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], pending: { ...s.sessions[id].pending, [category]: value } } } }));
      return;
    }
    await api.setByCategory(id, category, value);
  },

  reopen: async (id) => {
    await api.reopenSession(id);
  },

  renameSession: async (id, title) => {
    const t = title.trim();
    if (!t) return;
    await api.renameSession(id, t);
    set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id], record: { ...s.sessions[id].record, title: t } } } } : s));
  },

  stopSession: async (id) => {
    await api.closeSession(id);
  },

  removeSession: async (id, removeWorktree) => {
    // Remove it from any open pane with a close animation
    const pane = get().panes.slice(0, get().paneCount).indexOf(id);
    if (pane >= 0) get().closePane(pane);
    await api.deleteSession(id, removeWorktree);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      const unread = { ...s.unread };
      delete unread[id];
      return { sessions, unread, panes: s.panes.map((p) => (p === id ? null : p)) };
    });
  },
}));

/** For a stopped session, load the conversation from the log, and fetch config options if missing */
async function loadSession(id: string) {
  const v = useStore.getState().sessions[id];
  if (!v) return;
  if (!v.historyLoaded) {
    const events = await api.sessionHistory(id);
    useStore.setState((st) =>
      st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id], transcript: fromHistory(events), historyLoaded: true } } } : st,
    );
  }
  if (v.info === null) {
    const info = await api.sessionInfo(id);
    if (info) useStore.setState((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id], info } } } : st));
  }
}

// Persist the layout when it changes (drafts aren't kept)
useStore.subscribe((st, prev) => {
  if (
    !st.ready ||
    (st.panes === prev.panes && st.paneCount === prev.paneCount && st.focusedPane === prev.focusedPane && st.split === prev.split && st.sidebarOpen === prev.sidebarOpen && st.sidebarWidth === prev.sidebarWidth)
  )
    return;
  const layout: Layout = {
    // Drafts and previews are not restored on the next launch
    panes: st.panes.map((p) => (isDraft(p) || isPreview(p) ? null : p)),
    paneCount: st.paneCount,
    focusedPane: st.focusedPane,
    split: st.split,
    sidebarOpen: st.sidebarOpen,
    sidebarWidth: st.sidebarWidth,
  };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Failing to save doesn't affect behavior
  }
});

function firstFreePane(panes: (string | null)[], count: number, focused: number): number {
  const free = panes.slice(0, count).indexOf(null);
  return free >= 0 ? free : focused;
}

// When a session's config options change, remember them per profile
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
