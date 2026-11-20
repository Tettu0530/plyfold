// UI state. Engine events are received here and turned into a per-session view model

import { create } from "zustand";

import type { Look, LiquidStyle } from "@/components/liquid/liquid";
import { liquidCloseFrom, liquidOpen } from "@/components/liquid/stage";
import type { Attached } from "@/lib/attachments";
import { evenSizes, freeSlot, leaves, moveSlot, preset, removeSlot, setSizes, splitAt, swapSlots, validLayout, type Edge, type LayoutNode } from "./layout";
import { resolveLang, setLang, t } from "@/i18n";
import { api, inTauri, onEngineEvent } from "@/lib/api";
import { notify } from "@/lib/notify";
import { loadInfoCache, saveInfoCache, snapshot, type InfoCache } from "./infoCache";
import { commandsFromHistory } from "@/lib/commands";
import type { SlashCommand } from "@/lib/types";
import type { AppSettings, Category, SessionStatus, EngineEvent, ProfileSummary, ProfileUsage, QueuedTask, SessionInfo, SessionRecord } from "@/lib/types";
import { addNotice, applyUpdate, beginTurn, emptyTranscript, endTurn, fromHistory, type PendingPermission, type Transcript } from "./transcript";

export interface SideChat {
  /** The fork's session id, once it has started */
  id: string | null;
  /** When the main conversation was copied (shown as the age of its context) */
  openedAt: number;
  error: string | null;
}

/** Sessions listed in the UI (side chats live only inside their pane) */
export const isListed = (v: SessionView) => !v.record.side_of && !v.record.trashed_at;
/** In the trash (restorable; shown in the sidebar's trash group) */
export const isTrashed = (v: SessionView) => !v.record.side_of && !!v.record.trashed_at;

/** The find bar of one session. `active` indexes findMatches; `token` changes when the view should scroll to it */
export interface ConversationFind {
  sessionId: string;
  query: string;
  active: number;
  token: number;
}

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
  /** Slash commands from the session's log (used while the agent isn't running) */
  commands?: SlashCommand[];
}

/** A session not started yet (opens empty in a pane) */
export interface Draft {
  profile: string | null;
  repo: string;
  worktree: boolean;
  /** An everyday conversation instead of work in a repository */
  chat: boolean;
  /** model / effort / mode chosen before starting (applied right after start) */
  choices: Partial<Record<Category, string>>;
  /** Comparing: the profiles that each get the same prompt in a worktree of their own (null: one session) */
  compare?: string[] | null;
  busy: boolean;
  error: string | null;
}

export const isDraft = (id: string | null | undefined): id is string => !!id && id.startsWith("draft:");
/** A pane showing a web page (a dev server the agent started, or any URL) */
export const isPreview = (id: string | null | undefined): id is string => !!id && id.startsWith("preview:");

/** A pane showing a session's Git and changes ("git:<session id>") */
export const isGit = (id: string | null | undefined): id is string => !!id && id.startsWith("git:");
export const gitSessionOf = (id: string) => id.slice("git:".length);
export const gitPaneOf = (sessionId: string) => `git:${sessionId}`;

/** A pane comparing the sessions started together from one prompt ("compare:<run group>") */
export const isCompare = (id: string | null | undefined): id is string => !!id && id.startsWith("compare:");
export const compareGroupOf = (id: string) => id.slice("compare:".length);
export const comparePaneOf = (group: string) => `compare:${group}`;
/** At most this many sessions run side by side from one prompt */
export const COMPARE_MAX = 4;

/** A pane listing the files a session read or edited, with the picked one's contents ("files:<session id>") */
export const isFiles = (id: string | null | undefined): id is string => !!id && id.startsWith("files:");
export const filesSessionOf = (id: string) => id.slice("files:".length);
export const filesPaneOf = (sessionId: string) => `files:${sessionId}`;

export interface PreviewPage {
  url: string;
  /** liquidAnchor of the button it was opened from (the pane grows out of it and shrinks back into it) */
  anchor: string;
}

/** Pane appearance (the target of separation animations) */
const PANE_LOOK: Look = { background: "rgba(10, 10, 10, 1)", border: "rgba(255, 255, 255, 0.1)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
const settingsEl = () => document.querySelector<HTMLElement>("[data-settings-view]");
const profilesEl = () => document.querySelector<HTMLElement>("[data-profiles-view]");
const paneEl = (i: number) => document.querySelector<HTMLElement>(`[data-pane-index="${i}"]`);
const anchorOf = (id: string) =>
  isDraft(id)
    ? "new-session"
    : isPreview(id)
      ? (useStore.getState().previews[id]?.anchor ?? "new-session")
      : isGit(id)
        ? `diff:${gitSessionOf(id)}`
        : isFiles(id)
          ? `${filesSessionOf(id)}:files`
          : isCompare(id)
            ? `compare:${compareGroupOf(id)}`
            : `session:${id}`;
const LAST_REPO_KEY = "plyfold.lastRepo";
function lastRepo(): string {
  try {
    return localStorage.getItem(LAST_REPO_KEY) ?? "~/projects";
  } catch {
    return "~/projects";
  }
}

const LAST_PROFILE_KEY = "plyfold.lastProfile";

/** Size of the whole UI (webview zoom; CSS zoom in the browser preview) */
function applyScale(percent: number | undefined) {
  const f = (percent ?? 100) / 100;
  if (inTauri) {
    void import("@tauri-apps/api/webview").then((w) => w.getCurrentWebview().setZoom(f)).catch(() => {});
  } else {
    document.documentElement.style.zoom = f === 1 ? "" : String(f);
  }
}

/** "Reduce motion" in Settings: CSS reads the class (Motion reads the setting through MotionConfig) */
function applyMotion(setting: AppSettings["reduce_motion"] | undefined) {
  document.documentElement.classList.toggle("reduce-motion", setting === "reduce");
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
  /** Being edited: it is not sent (nor anything after it) until the edit is saved or cancelled */
  editing?: boolean;
}
let queueSeq = 0;

/** Engine event listener (only one per window, even if the store is reloaded during development) */
const engineListener = ((globalThis as { __plyfoldEngineListener?: { current: Promise<() => void> | null } }).__plyfoldEngineListener ??= { current: null });
let initStarted = false;

// Pane layout and the sessions shown in panes (restored at launch)
const LAYOUT_KEY = "plyfold.layout";
export interface Layout {
  /** Pane slots: what each slot shows (a session id), indexed by the leaves of `layout` */
  panes: (string | null)[];
  /** The split tree (state/layout.ts) */
  layout: LayoutNode;
  /** The focused slot */
  focusedPane: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

/** Sidebar width bounds and default (px) */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 240;
const clampSidebar = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, v))) : SIDEBAR_DEFAULT;

/** Restore the saved layout against current sessions (deleted sessions and drafts become empty panes) */
export function restoreLayout(saved: unknown, exists: (id: string) => boolean): Layout | null {
  if (!saved || typeof saved !== "object") return null;
  const o = saved as Partial<Layout> & { paneCount?: unknown };
  if (!Array.isArray(o.panes)) return null;
  // Older saves had a pane count (1 / 2 / 4) instead of a tree
  const legacy = o.paneCount === 1 || o.paneCount === 2 || o.paneCount === 4 ? preset(o.paneCount) : null;
  const layout = validLayout(o.layout) ?? legacy;
  if (!layout) return null;
  const size = Math.max(4, ...leaves(layout).map((i) => i + 1));
  const panes = Array.from({ length: size }, (_, i) => {
    const id = o.panes![i];
    return typeof id === "string" && !isDraft(id) && !isPreview(id) && !isGit(id) && !isFiles(id) && !isCompare(id) && exists(id) ? id : null;
  });
  const visible = leaves(layout);
  const focusedPane = typeof o.focusedPane === "number" && visible.includes(o.focusedPane) ? o.focusedPane : visible[0];
  const sidebarOpen = o.sidebarOpen !== false;
  return { panes, layout, focusedPane, sidebarOpen, sidebarWidth: clampSidebar(o.sidebarWidth) };
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
  /** Number of panes the layout shows */
  paneCount: number;
  focusedPane: number;
  searchOpen: boolean;
  /** In-pane find (⌘F) for one session, or null when the bar is closed */
  find: ConversationFind | null;
  labOpen: boolean;
  /** Separation animation style (chosen in the motion lab) */
  liquidStyle: LiquidStyle;
  /** Whether the search card's separation animation is running (raises the sidebar above the blob) */
  searchLayerActive: boolean;
  /** Separation animation size lag (seconds) */
  liquidLag: number;
  ready: boolean;

  init: () => Promise<void>;
  /** Split the focused pane and focus the new, empty pane */
  splitFocused: (edge: Edge) => void;
  /** Make all panes in every split the same size */
  evenLayout: () => void;
  /** The pane layout (split tree); paneCount is the number of panes it shows */
  layout: LayoutNode;
  /** Resize the split at `path` (dragging a divider) */
  setSplitSizes: (path: number[], sizes: number[]) => void;
  /** Put a session (or nothing) in a new pane next to `target`. Returns the new slot */
  splitPane: (target: number, edge: Edge, id: string | null, from?: string) => number;
  /** Move a pane next to another one, or swap the two (edge "center") */
  movePane: (slot: number, target: number, edge: Edge | "center") => void;
  /** Remove a pane from the layout (its session stays in the sidebar) */
  removePane: (slot: number) => void;
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
  openDiff: (id: string) => void;
  /** The files the session read or edited, as a pane beside it */
  openFiles: (id: string) => void;
  /** The comparison a session belongs to, as a pane beside it (it grows out of that session's compare button) */
  openCompare: (group: string, from: string) => void;
  /** Start one session per chosen profile, each in a worktree of its own, with the same prompt, side by side */
  startCompare: (draftId: string, prompt: string, attachments?: Attached[]) => Promise<void>;
  /** Bumped after worktree operations (so panes refetch their diff counts) */
  diffVersion: number;
  bumpDiff: () => void;
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
  /** Open the find bar, or close it if it is already open for this session */
  toggleFind: (sessionId: string) => void;
  /** Open the bar on a match (from ⌘K). `active` is an index into findMatches for this session */
  showFind: (sessionId: string, query: string, active: number) => void;
  setFindQuery: (query: string) => void;
  /** Move to another match. `count` is how many matches the open session has */
  stepFind: (delta: number, count: number) => void;
  closeFind: () => void;
  setLabOpen: (open: boolean) => void;
  setLiquidStyle: (s: LiquidStyle) => void;
  setSearchLayerActive: (v: boolean) => void;
  setLiquidLag: (v: number) => void;
  startSession: (args: { profile: string; repo: string; title: string; worktree: boolean; prompt?: string }) => Promise<void>;
  /** Fork into a new session. newWorktree is false only when the source agent is stopped */
  /** Hand the session over to another profile in the same workspace; the new session replaces it in its pane */
  handOver: (id: string, profile: string) => Promise<void>;
  forkSession: (id: string, newWorktree: boolean) => Promise<void>;
  /** Side chats, by the session they belong to. `id` is null while the fork starts */
  sideChats: Record<string, SideChat>;
  /** Open (or show again) the side chat of a session */
  openSideChat: (mainId: string) => Promise<void>;
  /** Close it: the fork is stopped and deleted */
  closeSideChat: (mainId: string) => Promise<void>;
  /** Start it again from the main conversation as it is now (the side conversation is dropped) */
  refreshSideChat: (mainId: string) => Promise<void>;
  /** Text to add to a session's input (an answer from its side chat); `n` makes each request distinct */
  composerInsert: { scope: string; text: string; n: number } | null;
  insertIntoComposer: (scope: string, text: string) => void;
  /** Open a conversation the CLI already has. The draft pane is replaced by the new session */
  adoptCliSession: (draftId: string, acpSessionId: string, title: string) => Promise<void>;
  sendPrompt: (id: string, text: string, attachments?: Attached[]) => Promise<void>;
  /** Instructions sent mid-turn (sent in order once the turn ends) */
  queues: Record<string, Queued[]>;
  enqueue: (id: string, text: string, attachments: Attached[]) => void;
  unqueue: (id: string, key: string) => void;
  /** Start or stop editing a queued message (cancelling keeps the text it had) */
  editQueued: (id: string, key: string, editing: boolean) => void;
  /** Save an edited queued message. If the agent is idle and it is first, it goes now */
  saveQueued: (id: string, key: string, text: string) => void;
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
  /** Prompts waiting to start as sessions, first first */
  tasks: QueuedTask[];
  /** Put the draft's prompt in the queue instead of starting it now */
  queueTask: (draftId: string, prompt: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  /** Start a queued task now, whatever is running */
  startTaskNow: (id: string) => Promise<void>;
  /** Start queued tasks while fewer than max_parallel sessions are busy */
  pumpTasks: () => Promise<void>;
  /** Names given to repositories' sidebar groups (path → name) */
  repoNames: Record<string, string>;
  loadRepoNames: () => Promise<void>;
  /** Rename a repository's group ("" goes back to the folder's name) */
  renameRepoGroup: (path: string, name: string) => Promise<void>;
  /** Delete for good (from the trash) */
  removeSession: (id: string, removeWorktree: boolean) => Promise<void>;
  /** Move to the trash: stops the agent and closes its panes; the record and worktree stay */
  trashSession: (id: string) => Promise<void>;
  restoreSession: (id: string) => Promise<void>;
  emptyTrash: (removeWorktree: boolean) => Promise<void>;
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
  if (e.type === "workspace_changed") {
    const v = sessions[e.session.id];
    return v ? { ...sessions, [e.session.id]: { ...v, record: e.session } } : sessions;
  }
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
    // An empty pane if there is one; otherwise a new pane to the right of the focused one
    const empty = leaves(s.layout).find((i) => !s.panes[i]);
    if (empty !== undefined) {
      void get().openInPane(id, empty, anchor);
      return;
    }
    get().splitPane(s.focusedPane, "right", null);
    const slot = leaves(get().layout).find((i) => !get().panes[i]);
    if (slot !== undefined) void get().openInPane(id, slot, anchor);
  },
  setPreviewUrl: (id, url) => set((s) => (s.previews[id] ? { previews: { ...s.previews, [id]: { ...s.previews[id], url } } } : s)),
  profiles: [],
  panes: [null, null, null, null],
  paneCount: 2,
  layout: preset(2),
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarResizing: false,
  focusedPane: 0,
  searchOpen: false,
  find: null,
  repoNames: {},
  tasks: [],
  labOpen: false,
  diffVersion: 0,
  bumpDiff: () => set((s) => ({ diffVersion: s.diffVersion + 1 })),
  profilesView: null,
  settingsView: null,
  infoCache: loadInfoCache(),
  unread: {},
  settings: {
    editor: "auto",
    cleanup_after_merge: false,
    stall_seconds: 120,
    worktree_default: true,
    send_key: "enter",
    language: "auto",
    sidebar_density: "comfortable",
    notify_turn_end: true,
    notify_permission: true,
    keybindings: {},
    ui_scale: 100,
    reduce_motion: "system",
    thoughts_expanded: false,
    restore_panes: true,
    default_profile: "",
  },
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
      // A session that stops working may make room for a queued task
      if (e.type === "status") queueMicrotask(() => void get().pumpTasks());
      set((s) => {
        const sessions = reduceEvent(s.sessions, e);
        // Also post a macOS notification when the app isn't in focus
        const subject = s.sessions[(e as { session_id?: string }).session_id ?? ""];
        // A side chat is answered in front of the user, and never asks for permission
        if (subject?.record.side_of) return { sessions };
        const title = subject?.record.title ?? t("store.fallbackTitle");
        const { notify_permission, notify_turn_end } = get().settings;
        if (e.type === "permission_requested" && notify_permission !== false) notify(title, t("store.notifyPermission"));
        if (e.type === "turn_ended" && notify_turn_end !== false)
          notify(title, e.error ? t("store.notifyError", { error: e.error }) : t("store.notifyTurnEnded"));
        // Record turn ends as notifications for sessions not on screen (or when the app isn't in focus)
        if (e.type === "turn_ended") {
          const shown = visibleSessions(s).includes(e.session_id) && document.hasFocus();
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
    const restored = restoreLayout(readLayout(), (id) => !!sessions[id]);
    // With "Reopen panes" off, keep the layout but start with empty panes
    const layout = restored && sv.settings.restore_panes === false ? { ...restored, panes: restored.panes.map(() => null) } : restored;
    applyLang(sv.settings.language);
    applyScale(sv.settings.ui_scale);
    applyMotion(sv.settings.reduce_motion);
    set({ profiles, sessions, settings: sv.settings, ready: true, ...(layout ? { ...layout, paneCount: leaves(layout.layout).length } : {}) });
    void get().loadRepoNames();
    void api.listTasks().then(
      (tasks) => {
        set({ tasks });
        void get().pumpTasks();
      },
      () => {},
    );
    for (const id of layout?.panes ?? []) if (id) void loadSession(id);
  },

  splitFocused: (edge) => {
    const slot = get().splitPane(get().focusedPane, edge, null);
    set({ focusedPane: slot });
  },
  evenLayout: () => set((s) => ({ layout: evenSizes(s.layout) })),
  setSplitSizes: (path, sizes) => set((s) => ({ layout: setSizes(s.layout, path, sizes) })),
  splitPane: (target, edge, id, from) => {
    const s = get();
    const slot = freeSlot(s.layout);
    const panes = [...s.panes];
    while (panes.length <= slot) panes.push(null);
    // A slot that is not shown may still hold something from an earlier layout; it is replaced
    panes[slot] = null;
    const layout = splitAt(s.layout, target, edge, slot);
    set({ layout, panes, paneCount: leaves(layout).length });
    if (id) void get().openInPane(id, slot, from);
    return slot;
  },
  movePane: (slot, target, edge) =>
    set((s) => {
      if (slot === target) return s;
      const layout = edge === "center" ? swapSlots(s.layout, slot, target) : moveSlot(s.layout, slot, target, edge);
      return { layout, paneCount: leaves(layout).length, focusedPane: slot };
    }),
  removePane: (slot) =>
    set((s) => {
      const layout = removeSlot(s.layout, slot);
      if (!layout) return s;
      const panes = [...s.panes];
      const gone = panes[slot];
      panes[slot] = null;
      const drafts = { ...s.drafts };
      if (isDraft(gone)) delete drafts[gone];
      const previews = { ...s.previews };
      if (isPreview(gone)) delete previews[gone];
      const shown = leaves(layout);
      return { layout, panes, drafts, previews, paneCount: shown.length, focusedPane: shown.includes(s.focusedPane) ? s.focusedPane : shown[0] };
    }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (px) => set({ sidebarWidth: clampSidebar(px) }),

  openInPane: async (id, pane, from) => {
    if (get().unread[id]) {
      const unread = { ...get().unread };
      delete unread[id];
      set({ unread });
    }
    const s = get();
    const already = leaves(s.layout).find((i) => s.panes[i] === id);
    if (already !== undefined && (pane === undefined || pane === already)) {
      set({ focusedPane: already });
    } else {
      // Moving a session that is already shown to another pane leaves its old pane empty
      const base = already !== undefined ? s.panes.map((p, i) => (i === already ? null : p)) : s.panes;
      const target = pane ?? firstFreePane(base, leaves(s.layout), s.focusedPane);
      const panes = [...base];
      while (panes.length <= target) panes.push(null);
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
    if (isDraft(id) || isPreview(id) || isGit(id) || isFiles(id) || isCompare(id)) return;
    await loadSession(id);
  },

  openDiff: (id) => {
    const s = get();
    const git = gitPaneOf(id);
    const shown = leaves(s.layout).find((i) => s.panes[i] === git);
    if (shown !== undefined) {
      set({ focusedPane: shown });
      return;
    }
    // Next to the session's pane (or the focused one), growing out of the session's Git button
    const beside = leaves(s.layout).find((i) => s.panes[i] === id) ?? s.focusedPane;
    const slot = get().splitPane(beside, "right", null);
    void get().openInPane(git, slot, `diff:${id}`);
  },

  openCompare: (group, from) => {
    const s = get();
    const pane = comparePaneOf(group);
    const shown = leaves(s.layout).find((i) => s.panes[i] === pane);
    if (shown !== undefined) {
      set({ focusedPane: shown });
      return;
    }
    const beside = leaves(s.layout).find((i) => s.panes[i] === from) ?? s.focusedPane;
    const slot = get().splitPane(beside, "right", null);
    void get().openInPane(pane, slot, `compare:${group}`);
  },

  startCompare: async (id, prompt, attachments = []) => {
    const d = get().drafts[id];
    const picks = d?.compare ?? [];
    if (!d || d.busy || d.chat || picks.length < 2) return;
    get().updateDraft(id, { busy: true, error: null });
    try {
      try {
        localStorage.setItem(LAST_REPO_KEY, d.repo);
      } catch {
        // Continue even if saving fails
      }
      const title = prompt.trim().split("\n")[0].slice(0, 40) || t("store.newSessionTitle");
      const group = crypto.randomUUID();
      // Started together; each gets its own worktree, port and setup run
      const started = await Promise.allSettled(picks.map((profile) => api.startSession({ profile, repo: d.repo, title, worktree: true })));
      const recs: SessionRecord[] = [];
      for (const r of started) if (r.status === "fulfilled") recs.push(await api.setRunGroup(r.value.id, group));
      const failed = started.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (recs.length === 0) throw failed?.reason ?? new Error("no session started");
      set((s) => {
        const panes = s.panes.map((p) => (p === id ? recs[0].id : p));
        const drafts = { ...s.drafts };
        delete drafts[id];
        const sessions = { ...s.sessions };
        for (const rec of recs) sessions[rec.id] = sessions[rec.id] ? { ...sessions[rec.id], record: rec } : { ...newView(rec), historyLoaded: true };
        return { panes, drafts, sessions };
      });
      // The others open to its right, one after another
      let slot = leaves(get().layout).find((i) => get().panes[i] === recs[0].id) ?? get().focusedPane;
      for (const rec of recs.slice(1)) slot = get().splitPane(slot, "right", rec.id, `session:${rec.id}`);
      if (prompt.trim() || attachments.length) for (const rec of recs) void get().sendPrompt(rec.id, prompt, attachments);
      // One that could not start is told in the first one's pane; the others run
      if (failed)
        set((s) => {
          const v = s.sessions[recs[0].id];
          return v ? { sessions: { ...s.sessions, [recs[0].id]: { ...v, lastError: t("store.compareStartFailed", { error: String(failed.reason) }) } } } : s;
        });
    } catch (e) {
      get().updateDraft(id, { busy: false, error: String(e) });
    }
  },

  openFiles: (id) => {
    const s = get();
    const pane = filesPaneOf(id);
    const shown = leaves(s.layout).find((i) => s.panes[i] === pane);
    if (shown !== undefined) {
      set({ focusedPane: shown });
      return;
    }
    // Next to the session's pane, growing out of its touched-files button
    const beside = leaves(s.layout).find((i) => s.panes[i] === id) ?? s.focusedPane;
    const slot = get().splitPane(beside, "right", null);
    void get().openInPane(pane, slot, `${id}:files`);
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
    if (patch.ui_scale) applyScale(next.ui_scale);
    if (patch.reduce_motion) applyMotion(next.reduce_motion);
    try {
      await api.saveSettings(next);
    } catch (e) {
      set({ settings: prev });
      if (patch.ui_scale) applyScale(prev.ui_scale);
      if (patch.reduce_motion) applyMotion(prev.reduce_motion);
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
    // A side chat lives only beside its pane
    if (id && get().sideChats[id]) void get().closeSideChat(id);
    // On close, shrink out of the pane back behind the anchor (the sidebar row). The pane itself goes away at once
    // (its neighbours grow into the space), so the blob starts from where the pane was
    const was = paneEl(pane)?.getBoundingClientRect();
    const ghost = was ? ({ getBoundingClientRect: () => was } as unknown as HTMLElement) : null;
    if (id) liquidCloseFrom(`pane-${pane}`, { anchor: anchorOf(id), target: () => ghost ?? paneEl(pane), toLook: PANE_LOOK });
    set((s) => {
      const panes = [...s.panes];
      panes[pane] = null;
      const drafts = { ...s.drafts };
      if (isDraft(id)) delete drafts[id];
      const previews = { ...s.previews };
      if (isPreview(id)) delete previews[id];
      // Closing a pane removes it from the layout; the last pane stays, empty
      const layout = leaves(s.layout).length > 1 ? (removeSlot(s.layout, pane) ?? s.layout) : s.layout;
      const shown = leaves(layout);
      return { panes, drafts, previews, layout, paneCount: shown.length, focusedPane: shown.includes(s.focusedPane) ? s.focusedPane : shown[0] };
    });
  },

  sideChats: {},
  composerInsert: null,
  insertIntoComposer: (scope, text) => set((s) => ({ composerInsert: { scope, text, n: (s.composerInsert?.n ?? 0) + 1 } })),

  openSideChat: async (mainId) => {
    if (get().sideChats[mainId]) return;
    set((s) => ({ sideChats: { ...s.sideChats, [mainId]: { id: null, openedAt: Date.now(), error: null } } }));
    try {
      const rec = await api.openSideChat(mainId);
      set((s) => {
        // Closed while it was starting
        if (!s.sideChats[mainId]) {
          void api.closeSideChat(rec.id);
          return s;
        }
        const cur = s.sessions[rec.id] ?? { ...newView(rec), historyLoaded: true };
        return {
          sessions: { ...s.sessions, [rec.id]: { ...cur, record: rec } },
          sideChats: { ...s.sideChats, [mainId]: { id: rec.id, openedAt: Date.now(), error: null } },
        };
      });
    } catch (e) {
      set((s) => (s.sideChats[mainId] ? { sideChats: { ...s.sideChats, [mainId]: { ...s.sideChats[mainId], error: String(e) } } } : s));
    }
  },

  closeSideChat: async (mainId) => {
    const side = get().sideChats[mainId];
    if (!side) return;
    set((s) => {
      const sideChats = { ...s.sideChats };
      delete sideChats[mainId];
      const sessions = { ...s.sessions };
      const queues = { ...s.queues };
      if (side.id) {
        delete sessions[side.id];
        delete queues[side.id];
      }
      return { sideChats, sessions, queues };
    });
    if (side.id) await api.closeSideChat(side.id).catch(() => {});
  },

  refreshSideChat: async (mainId) => {
    await get().closeSideChat(mainId);
    await get().openSideChat(mainId);
  },

  queues: {},
  enqueue: (id, text, attachments) => set((s) => ({ queues: { ...s.queues, [id]: [...(s.queues[id] ?? []), { key: `q${++queueSeq}`, text, attachments }] } })),
  unqueue: (id, key) => set((s) => ({ queues: { ...s.queues, [id]: (s.queues[id] ?? []).filter((q) => q.key !== key) } })),
  editQueued: (id, key, editing) => {
    set((s) => ({ queues: { ...s.queues, [id]: (s.queues[id] ?? []).map((q) => (q.key === key ? { ...q, editing } : q)) } }));
    // Cancelling an edit of the first message while idle: it was held back, so send it now
    if (!editing) get().sendQueued(id);
  },
  saveQueued: (id, key, text) => {
    set((s) => ({ queues: { ...s.queues, [id]: (s.queues[id] ?? []).map((q) => (q.key === key ? { ...q, text, editing: false } : q)) } }));
    get().sendQueued(id);
  },
  sendQueued: (id) => {
    const s = get();
    const [next, ...rest] = s.queues[id] ?? [];
    // Messages go in order, so one being edited holds back the ones after it too
    if (!next || next.editing || s.sessions[id]?.transcript.inTurn) return;
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
    set({
      drafts: {
        ...s.drafts,
        [id]: {
          profile: defaultProfile(s.profiles, s.settings.default_profile),
          repo: lastRepo(),
          worktree: s.settings.worktree_default,
          chat: false,
          choices: {},
          busy: false,
          error: null,
        },
      },
    });
    void get().openInPane(id, undefined, "new-session");
  },

  updateDraft: (id, patch) => set((s) => (s.drafts[id] ? { drafts: { ...s.drafts, [id]: { ...s.drafts[id], ...patch } } } : s)),

  startDraft: async (id, prompt, attachments = []) => {
    const d = get().drafts[id];
    if (!d?.profile || d.busy) return;
    get().updateDraft(id, { busy: true, error: null });
    try {
      try {
        if (!d.chat) localStorage.setItem(LAST_REPO_KEY, d.repo);
        localStorage.setItem(LAST_PROFILE_KEY, d.profile);
      } catch {
        // Continue even if saving fails
      }
      const title = prompt.trim().split("\n")[0].slice(0, 40) || (d.chat ? t("store.newChatTitle") : t("store.newSessionTitle"));
      const rec = d.chat ? await api.startChat(d.profile, title) : await api.startSession({ profile: d.profile, repo: d.repo, title, worktree: d.worktree });
      // Apply the model / effort / mode chosen in the draft before the first prompt (a conversation keeps its own mode)
      const { mode: _mode, ...rest } = d.choices;
      await applyChoices(rec.id, d.chat ? rest : d.choices);
      set((s) => {
        const panes = s.panes.map((p) => (p === id ? rec.id : p));
        const drafts = { ...s.drafts };
        delete drafts[id];
        // The view may already be there from SessionCreated, made before the workspace was set: keep it, with this record
        const cur = s.sessions[rec.id];
        const sessions = { ...s.sessions, [rec.id]: cur ? { ...cur, record: rec } : { ...newView(rec), historyLoaded: true } };
        return { panes, drafts, sessions };
      });
      if (prompt.trim() || attachments.length) await get().sendPrompt(rec.id, prompt, attachments);
    } catch (e) {
      get().updateDraft(id, { busy: false, error: String(e) });
    }
  },

  focusPane: (focusedPane) => set({ focusedPane }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  toggleFind: (sessionId) =>
    set((s) => ({
      find: s.find?.sessionId === sessionId ? null : { sessionId, query: "", active: 0, token: (s.find?.token ?? 0) + 1 },
    })),
  showFind: (sessionId, query, active) => set((s) => ({ find: { sessionId, query, active, token: (s.find?.token ?? 0) + 1 } })),
  setFindQuery: (query) => set((s) => (s.find ? { find: { ...s.find, query, active: 0, token: s.find.token + 1 } } : s)),
  stepFind: (delta, count) =>
    set((s) => {
      if (!s.find || count <= 0) return s;
      return { find: { ...s.find, active: (s.find.active + delta + count) % count, token: s.find.token + 1 } };
    }),
  closeFind: () => set({ find: null }),
  setLabOpen: (labOpen) => set({ labOpen }),
  setLiquidStyle: (liquidStyle) => set({ liquidStyle }),
  setSearchLayerActive: (searchLayerActive) => set({ searchLayerActive }),
  setLiquidLag: (liquidLag) => set({ liquidLag }),

  startSession: async ({ prompt, ...args }) => {
    const rec = await api.startSession(args);
    await get().openInPane(rec.id);
    if (prompt?.trim()) await get().sendPrompt(rec.id, prompt);
  },

  handOver: async (id, profile) => {
    const rec = await api.handOver(id, profile);
    // The new session takes the old one's pane
    const slot = get().panes.indexOf(id);
    if (slot >= 0) set((s) => ({ panes: s.panes.map((p) => (p === id ? rec.id : p)) }));
    else await get().openInPane(rec.id, undefined, `session:${id}`);
  },

  forkSession: async (id, newWorktree) => {
    const rec = await api.forkSession(id, newWorktree);
    // SessionCreated marks history as loaded, but the copied conversation is only in the log
    set((s) => {
      const cur = s.sessions[rec.id] ?? newView(rec);
      return { sessions: { ...s.sessions, [rec.id]: { ...cur, record: rec, historyLoaded: false } } };
    });
    await get().openInPane(rec.id, undefined, `session:${id}`);
  },

  adoptCliSession: async (draftId, acpSessionId, title) => {
    const d = get().drafts[draftId];
    if (!d?.profile || d.busy) return;
    get().updateDraft(draftId, { busy: true, error: null });
    try {
      const rec = await api.adoptCliSession(d.profile, d.repo, acpSessionId, title, d.worktree);
      // The conversation is the history the agent resent, copied into the log after SessionCreated
      set((s) => {
        const cur = s.sessions[rec.id] ?? newView(rec);
        return { sessions: { ...s.sessions, [rec.id]: { ...cur, record: rec, historyLoaded: false } } };
      });
      const pane = leaves(get().layout).find((i) => get().panes[i] === draftId);
      await get().openInPane(rec.id, pane, `${draftId}:cli`);
    } catch (e) {
      get().updateDraft(draftId, { busy: false, error: String(e) });
    }
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
      await api.prompt(
        id,
        text,
        attachments.map((a) => a.wire),
      );
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

  queueTask: async (draftId, prompt) => {
    const d = get().drafts[draftId];
    if (!d?.profile || d.chat || !prompt.trim()) return;
    const task: QueuedTask = {
      id: crypto.randomUUID(),
      profile: d.profile,
      repo: d.repo,
      worktree: d.worktree,
      prompt,
      title: prompt.trim().split("\n")[0].slice(0, 40),
      created_at: Date.now(),
    };
    const tasks = [...get().tasks, task];
    await api.saveTasks(tasks);
    set({ tasks });
    void get().pumpTasks();
  },

  cancelTask: async (id) => {
    const tasks = get().tasks.filter((t) => t.id !== id);
    await api.saveTasks(tasks);
    set({ tasks });
  },

  startTaskNow: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (task) await runTask(task);
  },

  pumpTasks: async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const s = get();
        const limit = s.settings.max_parallel ?? 2;
        const busy = Object.values(s.sessions).filter((v) => !v.record.side_of && BUSY.includes(v.record.status)).length;
        const next = s.tasks.find((t) => !t.error);
        if (!next || busy + starting >= limit) break;
        await runTask(next);
      }
    } finally {
      pumping = false;
    }
  },

  loadRepoNames: async () => {
    const repos = await api.listRepos().catch(() => []);
    set({ repoNames: Object.fromEntries(repos.filter((r) => r.settings.name).map((r) => [r.path, r.settings.name])) });
  },

  renameRepoGroup: async (path, name) => {
    await api.renameRepo(path, name);
    set((s) => {
      const repoNames = { ...s.repoNames };
      if (name.trim()) repoNames[path] = name.trim();
      else delete repoNames[path];
      return { repoNames };
    });
  },

  trashSession: async (id) => {
    for (const pane of [id, gitPaneOf(id), filesPaneOf(id)]) {
      const slot = leaves(get().layout).find((i) => get().panes[i] === pane);
      if (slot !== undefined) get().closePane(slot);
    }
    const rec = await api.trashSession(id);
    set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id], record: rec } } } : s));
  },

  restoreSession: async (id) => {
    const rec = await api.restoreSession(id);
    set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id], record: rec } } } : s));
  },

  emptyTrash: async (removeWorktree) => {
    const gone = await api.emptyTrash(removeWorktree);
    set((s) => {
      const sessions = { ...s.sessions };
      const unread = { ...s.unread };
      for (const id of gone) {
        delete sessions[id];
        delete unread[id];
      }
      return { sessions, unread };
    });
  },

  removeSession: async (id, removeWorktree) => {
    // Remove it from any open pane with a close animation
    const pane = leaves(get().layout).find((i) => get().panes[i] === id);
    if (pane !== undefined) get().closePane(pane);
    const git = leaves(get().layout).find((i) => get().panes[i] === gitPaneOf(id));
    if (git !== undefined) get().closePane(git);
    const files = leaves(get().layout).find((i) => get().panes[i] === filesPaneOf(id));
    if (files !== undefined) get().closePane(files);
    await api.deleteSession(id, removeWorktree);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      // The engine deletes its side chat with it
      const sideChats = { ...s.sideChats };
      const side = sideChats[id]?.id;
      if (side) delete sessions[side];
      delete sideChats[id];
      const unread = { ...s.unread };
      delete unread[id];
      return { sessions, unread, sideChats, panes: s.panes.map((p) => (p === id ? null : p)) };
    });
  },
}));

// ---- the task queue

const BUSY: SessionStatus[] = ["starting", "working", "awaiting_permission", "stalled"];
/** One pump at a time; tasks being started count as busy until their session reports a state */
let pumping = false;
let starting = 0;

/** Take a task off the queue and start it as a session (in the sidebar; no pane is taken) */
async function runTask(queued: QueuedTask) {
  const task = { ...queued, error: null };
  const store = useStore.getState();
  const tasks = store.tasks.filter((t) => t.id !== task.id);
  useStore.setState({ tasks });
  await api.saveTasks(tasks).catch(() => {});
  starting += 1;
  try {
    const rec = await api.startSession({ profile: task.profile, repo: task.repo, title: task.title || t("store.newSessionTitle"), worktree: task.worktree });
    useStore.setState((s) => ({
      sessions: { ...s.sessions, [rec.id]: s.sessions[rec.id] ? { ...s.sessions[rec.id], record: rec } : { ...newView(rec), historyLoaded: true } },
    }));
    await useStore.getState().sendPrompt(rec.id, task.prompt);
  } catch (e) {
    // Back at the head of the queue with the reason, waiting to be started again by hand
    const back = [{ ...task, error: String(e).slice(0, 500) }, ...useStore.getState().tasks];
    useStore.setState({ tasks: back });
    await api.saveTasks(back).catch(() => {});
  } finally {
    starting -= 1;
  }
}

/** For a stopped session, load the conversation from the log, and fetch config options if missing */
async function loadSession(id: string) {
  const v = useStore.getState().sessions[id];
  if (!v) return;
  if (!v.historyLoaded) {
    const events = await api.sessionHistory(id);
    const commands = commandsFromHistory(events);
    useStore.setState((st) => {
      if (!st.sessions[id]) return st;
      const sessions = { ...st.sessions, [id]: { ...st.sessions[id], transcript: fromHistory(events), historyLoaded: true, commands } };
      // New sessions with this profile can offer the same commands (when the profile's options are already remembered)
      const profile = st.sessions[id].record.profile;
      const known = st.infoCache[profile];
      if (!commands.length || !known || known.commands?.length) return { sessions };
      const infoCache = { ...st.infoCache, [profile]: { ...known, commands } };
      saveInfoCache(infoCache);
      return { sessions, infoCache };
    });
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
    (st.panes === prev.panes &&
      st.layout === prev.layout &&
      st.focusedPane === prev.focusedPane &&
      st.sidebarOpen === prev.sidebarOpen &&
      st.sidebarWidth === prev.sidebarWidth)
  )
    return;
  const layout: Layout = {
    // Drafts, previews, Git and file panes are not restored on the next launch
    panes: st.panes.map((p) => (isDraft(p) || isPreview(p) || isGit(p) || isFiles(p) || isCompare(p) ? null : p)),
    layout: st.layout,
    focusedPane: st.focusedPane,
    sidebarOpen: st.sidebarOpen,
    sidebarWidth: st.sidebarWidth,
  };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Failing to save doesn't affect behavior
  }
});

/**
 * Profile a new session starts with: the one chosen in Settings, else the one used last, else the first profile with
 * its own name (falling back to any profile)
 */
export function defaultProfile(profiles: ProfileSummary[], setting: string | undefined, last = readLastProfile()): string | null {
  const has = (n: string | null | undefined) => !!n && profiles.some((p) => p.name === n);
  if (has(setting)) return setting!;
  if (has(last)) return last;
  return (profiles.find((p) => p.name !== p.agent) ?? profiles[0])?.name ?? null;
}

function readLastProfile(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE_KEY);
  } catch {
    return null;
  }
}

/** The first empty pane in layout order, or the focused one */
function firstFreePane(panes: (string | null)[], shown: number[], focused: number): number {
  return shown.find((i) => !panes[i]) ?? focused;
}

/** Session ids shown in panes right now */
/** Whether a pane in the layout shows this id */
export const leavesShowing = (s: { panes: (string | null)[]; layout: LayoutNode }, id: string) => leaves(s.layout).some((i) => s.panes[i] === id);
export const visibleSessions = (s: { panes: (string | null)[]; layout: LayoutNode }) => leaves(s.layout).map((i) => s.panes[i]);

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
