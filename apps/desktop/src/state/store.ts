// UI state. Engine events are received here and turned into a per-session view model

import { useEffect } from "react";
import { create } from "zustand";

import type { LiquidStyle } from "@/components/liquid/liquid";
import type { Attached } from "@/lib/attachments";
import { evenSizes, freeSlot, leaves, moveSlot, preset, removeSlot, setSizes, splitAt, swapSlots, validLayout, type Edge, type LayoutNode } from "./layout";
import { resolveLang, setLang, t } from "@/i18n";
import { api, inTauri, onEngineEvent } from "@/lib/api";
import { notify } from "@/lib/notify";
import { loadInfoCache, saveInfoCache, snapshot, type InfoCache } from "./infoCache";
import { commandsFromHistory } from "@/lib/commands";
import type { SlashCommand } from "@/lib/types";
import type {
  AppSettings,
  Category,
  SessionStatus,
  EngineEvent,
  ProfileSummary,
  ProfileUsage,
  QueuedTask,
  SessionInfo,
  SessionRecord,
  ShellEvent,
} from "@/lib/types";
import {
  addNotice,
  addShell,
  applyUpdate,
  beginTurn,
  emptyTranscript,
  endTurn,
  fromHistory,
  type PendingPermission,
  type Transcript,
  updateShell,
} from "./transcript";

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
  sendingFirstPrompt?: boolean;
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
  retryInput?: { text: string; attachments: Attached[] };
  busy: boolean;
  error: string | null;
}

/** Whether this folder is in a git repository: true until it is known not to be (so a repository's Git view never waits) */
export function useIsGitFolder(path: string | null | undefined): boolean {
  const known = useStore((st) => (path ? st.gitFolders[path] : undefined));
  useEffect(() => {
    if (path && known === undefined) void useStore.getState().checkGitFolder(path);
  }, [path, known]);
  return known !== false;
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

export const isTerminal = (id: string | null | undefined): id is string => !!id && id.startsWith("terminal:");
/** The terminal that is in no session's folder: it opens in the home folder (the id after "terminal:") */
export const HOME_TERMINAL = "~";
export const terminalPaneOf = (sessionId: string) => `terminal:${sessionId}`;
export const terminalSessionOf = (id: string) => id.slice("terminal:".length);

export interface PreviewPage {
  url: string;
  /** liquidAnchor of the button it was opened from (the pane grows out of it and shrinks back into it) */
  anchor: string;
}

/** A pane listing the files a session read or edited, with the picked one's contents ("files:<session id>") */ const LAST_REPO_KEY = "plyfold.lastRepo";
const VERDICTS_KEY = "plyfold.verdicts";
function readVerdicts(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(VERDICTS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
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
  /** "Send now" was chosen mid-turn: the turn is being stopped, and this goes out as soon as it has */
  now?: boolean;
}
let queueSeq = 0;
const openingSideChats = new Map<string, Promise<SessionRecord>>();

const STREAM_FLUSH_MS = 40;
let pendingStreamEvents: EngineEvent[] = [];
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushStreamEvents() {
  if (streamFlushTimer !== null) clearTimeout(streamFlushTimer);
  streamFlushTimer = null;
  const events = pendingStreamEvents;
  pendingStreamEvents = [];
  if (!events.length) return;
  useStore.setState((s) => {
    let sessions = s.sessions;
    for (const e of events) sessions = reduceEvent(sessions, e);
    return sessions === s.sessions ? s : { sessions };
  });
}

function scheduleStreamEvent(e: Extract<EngineEvent, { type: "update" }>) {
  const update = e.update;
  const tail = pendingStreamEvents[pendingStreamEvents.length - 1];
  // Coalesce adjacent chunks of the same stream. Payloads have already been persisted by the engine.
  if (tail?.type === "update" && tail.session_id === e.session_id && tail.update.sessionUpdate === update.sessionUpdate) {
    const prevText = (tail.update.content as { text?: string } | undefined)?.text;
    const nextText = (update.content as { text?: string } | undefined)?.text;
    if (typeof prevText === "string" && typeof nextText === "string") {
      pendingStreamEvents[pendingStreamEvents.length - 1] = {
        ...tail,
        update: { ...tail.update, content: { type: (update.content as { type?: string }).type, text: prevText + nextText } },
      };
    } else pendingStreamEvents.push(e);
  } else pendingStreamEvents.push(e);
  if (streamFlushTimer === null) streamFlushTimer = setTimeout(flushStreamEvents, STREAM_FLUSH_MS);
}

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
    return typeof id === "string" && !isDraft(id) && !isPreview(id) && !isGit(id) && !isFiles(id) && !isTerminal(id) && !isCompare(id) && exists(id)
      ? id
      : null;
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
  /** The session that judged a comparison, by run group (kept on this machine, so the answer is found again) */
  verdicts: Record<string, string>;
  setVerdict: (group: string, session: string) => void;
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
  /** Put the cursor in the input of the session or draft in this pane (nothing for panes without one) */
  focusPaneInput: (slot: number) => void;
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
  /** Opens the session's terminal beside its pane. `anchor` is the button the pane grows out of (default: the shells button) */
  openTerminal: (id: string, anchor?: string) => void;
  /** The comparison a session belongs to, as a pane beside it (it grows out of that session's compare button) */
  openCompare: (group: string, from: string) => void;
  /** Start one session per chosen profile, each in a worktree of its own, with the same prompt, side by side */
  startCompare: (draftId: string, prompt: string, attachments?: Attached[]) => Promise<void>;
  /** Run a finished session's first instruction again with another profile (and model) in a new worktree, side by side with it */
  rerunSession: (id: string, profile: string, model?: string) => Promise<void>;
  /** Bumped after worktree operations (so panes refetch their diff counts) */
  diffVersion: number;
  bumpDiff: () => void;
  /** Profiles screen (kept mounted during the close animation, like the diff screen) */
  profilesView: { closing: boolean } | null;
  settingsView: { closing: boolean } | null;
  /** Per-profile config options from the last session (used by drafts) */
  infoCache: InfoCache;
  effort: EffortPreferences;
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
  /** Hide the side chat while keeping its conversation */
  closeSideChat: (mainId: string) => Promise<void>;
  /** Clear the side conversation and fork again from the main conversation */
  refreshSideChat: (mainId: string) => Promise<void>;
  /** Text to add to a session's input (an answer from its side chat); `n` makes each request distinct */
  composerInsert: { scope: string; text: string; n: number } | null;
  insertIntoComposer: (scope: string, text: string) => void;
  /** Open a conversation the CLI already has. The draft pane is replaced by the new session */
  adoptCliSession: (draftId: string, acpSessionId: string, title: string) => Promise<void>;
  sendPrompt: (id: string, text: string, attachments?: Attached[]) => Promise<void>;
  /** Run `!command` in the session's folder. The output stays in the conversation view only */
  runShell: (id: string, command: string) => Promise<void>;
  stopShell: (run: number) => void;
  /** Send a finished shell run to the agent as the next instruction (queued mid-turn) */
  sendShellOn: (id: string, run: number) => void;
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
  /** Whether a folder is inside a git repository (checked once per folder; a missing entry is not known yet) */
  gitFolders: Record<string, boolean>;
  checkGitFolder: (path: string) => Promise<boolean>;
  /** Send this queued message first, stopping the current turn if one is running */
  sendQueuedNow: (id: string, key: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  respondPermission: (id: string, optionId: string | null) => Promise<void>;
  setCategory: (id: string, category: Category, value: string) => Promise<void>;
  reopen: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** Stop the agent (the log and worktree remain) */
  stopSession: (id: string) => Promise<void>;
  /** Delete along with the log. With removeWorktree, also delete the worktree and branch */
  /** Sessions whose prompt waits for a usage limit to lift, and when it goes out (ms) */
  resumes: Record<string, number>;
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

type EffortPreferences = { profiles: Record<string, string>; sessions: Record<string, string> };
const EFFORT_KEY = "plyfold.effort.v1";

function loadEffort(): EffortPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(EFFORT_KEY) ?? "{}") as Partial<EffortPreferences> | null;
    return { profiles: saved?.profiles ?? {}, sessions: saved?.sessions ?? {} };
  } catch {
    return { profiles: {}, sessions: {} };
  }
}

function rememberEffort(record: SessionRecord, value: string, updateDefault: boolean) {
  useStore.setState((state) => {
    const effort = {
      profiles: updateDefault ? { ...state.effort.profiles, [record.profile]: value } : state.effort.profiles,
      sessions: { ...state.effort.sessions, [record.id]: value },
    };
    try {
      localStorage.setItem(EFFORT_KEY, JSON.stringify(effort));
    } catch {
      // The choice is still available for this run.
    }
    return { effort };
  });
}

/** The mode ids an agent offers (the mode option's choices, or the legacy mode list) */
export function modeIds(info: Pick<SessionInfo, "config" | "modes"> | null | undefined): string[] {
  if (!info) return [];
  return info.config.find((o) => o.category === "mode")?.choices.map((c) => c.value) ?? info.modes.map((m) => m.value);
}

async function applyStartingChoices(record: SessionRecord, choices: Partial<Record<Category, string>> = {}, softMode?: string) {
  const effort = choices.thought_level ?? useStore.getState().effort.profiles[record.profile];
  return applyChoices(record.id, effort === undefined ? choices : { ...choices, thought_level: effort }, record, choices.thought_level !== undefined, softMode);
}

async function reopenWithChoices(id: string) {
  await api.reopenSession(id);
  const s = useStore.getState();
  const pending = s.sessions[id]?.pending ?? {};
  const effort = s.effort.sessions[id];
  await applyChoices(id, effort === undefined ? pending : { ...pending, thought_level: effort });
  useStore.setState((state) => (state.sessions[id] ? { sessions: { ...state.sessions, [id]: { ...state.sessions[id], pending: {} } } } : state));
}

/** Right after start, apply the preselected model / effort / mode (skipped if unchanged) */
async function applyChoices(id: string, choices: Partial<Record<Category, string>>, record?: SessionRecord, updateEffortDefault = false, softMode?: string) {
  const { thought_level: effort, ...otherChoices } = choices;
  const wanted = Object.entries(otherChoices) as [Category, string][];
  if (effort !== undefined) wanted.push(["thought_level", effort]);
  let info = wanted.length > 0 || softMode ? await api.sessionInfo(id) : null;
  // The mode from Settings, only if the agent has it and none was chosen on the draft
  if (softMode && choices.mode === undefined && modeIds(info).includes(softMode)) wanted.push(["mode", softMode]);
  if (wanted.length === 0) return;
  for (const [cat, value] of wanted) {
    const opt = info?.config.find((o) => o.category === cat);
    const cur = cat === "mode" ? (opt?.current ?? info?.current_mode) : opt?.current;
    if (cat === "thought_level" && !opt?.choices.some((choice) => choice.value === value) && cur !== value) continue;
    try {
      if (cur !== value) {
        await api.setByCategory(id, cat, value);
        // The selected model may expose a different set of effort values.
        if (cat === "model" && effort !== undefined) info = await api.sessionInfo(id);
      }
      if (cat === "thought_level" && record) rememberEffort(record, value, updateEffortDefault);
    } catch {
      // If the options changed, start with the agent's defaults.
    }
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
    if (sessions[e.session.id]?.sendingFirstPrompt) return sessions;
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
  verdicts: readVerdicts(),
  setVerdict: (group, session) =>
    set((s) => {
      const verdicts = { ...s.verdicts, [group]: session };
      try {
        localStorage.setItem(VERDICTS_KEY, JSON.stringify(verdicts));
      } catch {
        // Not remembered, still applied
      }
      return { verdicts };
    }),
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
  resumes: {},
  labOpen: false,
  diffVersion: 0,
  bumpDiff: () => set((s) => ({ diffVersion: s.diffVersion + 1 })),
  profilesView: null,
  settingsView: null,
  infoCache: loadInfoCache(),
  effort: loadEffort(),
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
    default_mode: "",
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
      // (a stop chosen by "send now" is the exception: the message that asked for it goes out)
      if (e.type === "turn_ended" && !e.error && (e.stop_reason !== "cancelled" || get().queues[e.session_id]?.[0]?.now))
        queueMicrotask(() => get().sendQueued(e.session_id));
      // A session that stops working may make room for a queued task
      if (e.type === "status") queueMicrotask(() => void get().pumpTasks());
      if (e.type === "resume_scheduled") {
        set((s) => {
          const resumes = { ...s.resumes };
          if (e.at) resumes[e.session_id] = e.at;
          else delete resumes[e.session_id];
          return { resumes };
        });
      }
      if (e.type === "update") {
        scheduleStreamEvent(e);
        return;
      }
      flushStreamEvents();
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
    void api.scheduledResumes().then(
      (list) => set({ resumes: Object.fromEntries(list) }),
      () => {},
    );
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
  removePane: (slot) => {
    const wasFocused = get().focusedPane === slot;
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
      return { layout, panes, drafts, previews, paneCount: shown.length, focusedPane: focusAfterClose(s.layout, layout, slot, s.focusedPane) };
    });
    if (wasFocused) get().focusPaneInput(get().focusedPane);
  },
  focusPaneInput: (slot) => {
    const id = get().panes[slot];
    if (id && (isDraft(id) || get().sessions[id])) get().insertIntoComposer(id, "");
  },
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (px) => set({ sidebarWidth: clampSidebar(px) }),

  openInPane: async (id, pane) => {
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
      const drafts = { ...s.drafts };
      if (isDraft(displaced)) delete drafts[displaced!];
      const previews = { ...s.previews };
      if (isPreview(displaced)) delete previews[displaced!];
      set({ panes, focusedPane: target, drafts, previews });
    }
    if (isDraft(id) || isPreview(id) || isGit(id) || isFiles(id) || isTerminal(id) || isCompare(id)) return;
    await loadSession(id);
    // A session opened (or brought forward) takes the cursor, as it would if the pane were clicked. Not when the user has
    // moved on to another pane while it loaded
    if (get().panes[get().focusedPane] === id) get().insertIntoComposer(id, "");
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

  rerunSession: async (id, profile, model) => {
    if (!get().sessions[id]?.historyLoaded) await loadSession(id);
    const src = get().sessions[id];
    const first = src?.transcript.items.find((it) => it.kind === "user");
    const repo = src?.record.repo_path;
    if (!src || !repo || !src.record.worktree_path || first?.kind !== "user") throw new Error(t("store.rerunUnavailable"));
    try {
      // The session and its rerun share a run group, which is what a comparison pane lists
      const group = src.record.run_group ?? crypto.randomUUID();
      const srcRecord = src.record.run_group ? src.record : await api.setRunGroup(id, group);
      const started = await api.startSession({ profile, repo, title: src.record.title, worktree: true });
      const rec = await api.setRunGroup(started.id, group);
      await applyStartingChoices(rec, model ? { model } : {});
      set((s) => {
        const sessions = { ...s.sessions };
        sessions[id] = { ...sessions[id], record: srcRecord };
        sessions[rec.id] = sessions[rec.id] ? { ...sessions[rec.id], record: rec } : { ...newView(rec), historyLoaded: true };
        return { sessions };
      });
      get().openCompare(group, id);
      await get().sendPrompt(rec.id, first.text);
    } catch (e) {
      throw new Error(t("store.rerunFailed", { error: String(e) }), { cause: e });
    }
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
      await Promise.all(
        recs.map((rec) =>
          applyStartingChoices(
            rec,
            rec.profile === picks[0] && d.choices.thought_level !== undefined ? { thought_level: d.choices.thought_level } : {},
            get().settings.default_mode,
          ),
        ),
      );
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

  openTerminal: (id, anchor) => {
    const s = get();
    const pane = terminalPaneOf(id);
    const slots = leaves(s.layout);
    const shown = slots.find((slot) => s.panes[slot] === pane);
    if (shown !== undefined) {
      set({ focusedPane: shown });
      return;
    }
    const beside = slots.find((slot) => s.panes[slot] === id) ?? s.focusedPane;
    get().splitPane(beside, "right", pane, anchor ?? `${id}:shells`);
  },

  openProfiles: () => {
    if (get().profilesView) return;
    set({ profilesView: { closing: false } });
  },

  closeProfiles: () => {
    const v = get().profilesView;
    if (!v || v.closing) return;
    set({ profilesView: null });
  },

  openSettings: () => {
    if (get().settingsView) return;
    set({ settingsView: { closing: false } });
  },

  closeSettings: () => {
    const v = get().settingsView;
    if (!v || v.closing) return;
    set({ settingsView: null });
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
    const wasFocused = get().focusedPane === pane;
    // A side chat lives only beside its pane
    if (id && get().sideChats[id]) void get().closeSideChat(id);
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
      return { panes, drafts, previews, layout, paneCount: shown.length, focusedPane: focusAfterClose(s.layout, layout, pane, s.focusedPane) };
    });
    if (wasFocused) get().focusPaneInput(get().focusedPane);
  },

  sideChats: {},
  composerInsert: null,
  runShell: async (id, command) => {
    const change = (f: (t: Transcript) => Transcript) =>
      set((s) => {
        const v = s.sessions[id];
        return v ? { sessions: { ...s.sessions, [id]: { ...v, transcript: f(v.transcript) } } } : {};
      });
    // Events can arrive before the run id does
    const early: ShellEvent[] = [];
    let run: number | null = null;
    const apply = (r: number, e: ShellEvent) =>
      change((t) =>
        updateShell(t, r, (item) =>
          e.kind === "output" ? { ...item, output: item.output + e.data } : { ...item, status: "done", code: e.code, truncated: e.truncated },
        ),
      );
    try {
      run = await api.startShell(id, command, (e) => (run === null ? early.push(e) : apply(run, e)));
    } catch (error) {
      change((t) => addNotice(t, String(error)));
      return;
    }
    const started = run;
    change((t) => addShell(t, started, command));
    for (const e of early) apply(started, e);
  },
  stopShell: (run) => void api.stopShell(run),
  sendShellOn: (id, run) => {
    const v = get().sessions[id];
    const item = v?.transcript.items.find((it) => it.kind === "shell" && it.run === run);
    if (!v || !item || item.kind !== "shell") return;
    const code = item.code === null ? "" : ` (exit ${item.code})`;
    const text = `I ran a command in the session folder${code}:\n\n~~~~\n$ ${item.command}\n${item.output.trimEnd()}\n~~~~`;
    if (v.transcript.inTurn) get().enqueue(id, text, []);
    else void get().sendPrompt(id, text);
  },
  insertIntoComposer: (scope, text) => set((s) => ({ composerInsert: { scope, text, n: (s.composerInsert?.n ?? 0) + 1 } })),

  openSideChat: async (mainId) => {
    if (get().sideChats[mainId]) return;
    const existing = Object.values(get().sessions).find((v) => v.record.side_of === mainId && !v.record.review);
    const opening: SideChat = { id: null, openedAt: existing?.record.created_at ?? Date.now(), error: null };
    set((s) => ({ sideChats: { ...s.sideChats, [mainId]: opening } }));
    try {
      let rec = existing?.record;
      let pending = openingSideChats.get(mainId);
      if (!rec || pending) {
        if (!pending) {
          pending = api.openSideChat(mainId);
          openingSideChats.set(mainId, pending);
          void pending
            .finally(() => {
              if (openingSideChats.get(mainId) === pending) openingSideChats.delete(mainId);
            })
            .catch(() => {});
        }
        rec = await pending;
      }
      const sideRecord = rec;
      set((s) => {
        const cur = s.sessions[sideRecord.id] ?? { ...newView(sideRecord), historyLoaded: true };
        const sessions = { ...s.sessions, [sideRecord.id]: { ...cur, record: sideRecord } };
        return { sessions };
      });
      await loadSession(sideRecord.id);
      set((s) =>
        s.sideChats[mainId] === opening ? { sideChats: { ...s.sideChats, [mainId]: { id: sideRecord.id, openedAt: sideRecord.created_at, error: null } } } : s,
      );
    } catch (e) {
      set((s) => (s.sideChats[mainId] === opening ? { sideChats: { ...s.sideChats, [mainId]: { ...opening, error: String(e) } } } : s));
    }
  },

  closeSideChat: async (mainId) => {
    set((s) => {
      if (!s.sideChats[mainId]) return s;
      const sideChats = { ...s.sideChats };
      delete sideChats[mainId];
      return { sideChats };
    });
  },

  refreshSideChat: async (mainId) => {
    const side = get().sideChats[mainId];
    if (!side) return;
    if (side.id) {
      try {
        await api.closeSideChat(side.id);
      } catch (e) {
        set((s) => (s.sideChats[mainId] === side ? { sideChats: { ...s.sideChats, [mainId]: { ...side, error: String(e) } } } : s));
        return;
      }
      set((s) => {
        const sessions = { ...s.sessions };
        const queues = { ...s.queues };
        delete sessions[side.id!];
        delete queues[side.id!];
        return { sessions, queues };
      });
    }
    if (get().sideChats[mainId] === side) {
      await get().closeSideChat(mainId);
      await get().openSideChat(mainId);
    }
  },

  gitFolders: {},
  checkGitFolder: async (path) => {
    const known = get().gitFolders[path];
    if (known !== undefined) return known;
    let git = true;
    try {
      git = inTauri ? await api.folderIsGit(path) : true;
    } catch {
      // Unknown: treat it as a repository, as before
    }
    set((st) => ({ gitFolders: { ...st.gitFolders, [path]: git } }));
    return git;
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

  sendQueuedNow: async (id, key) => {
    const queue = get().queues[id] ?? [];
    const picked = queue.find((q) => q.key === key);
    if (!picked) return;
    const busy = !!get().sessions[id]?.transcript.inTurn;
    set({ queues: { ...get().queues, [id]: [{ ...picked, editing: false, now: busy }, ...queue.filter((q) => q.key !== key)] } });
    if (!busy) return get().sendQueued(id);
    try {
      await api.cancel(id);
    } catch {
      // It stays first in the queue and goes out when the turn ends
      set((s) => ({ queues: { ...s.queues, [id]: (s.queues[id] ?? []).map((q) => (q.key === key ? { ...q, now: false } : q)) } }));
    }
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
    // A new session that is already open and not started is brought forward rather than opened again
    const open = leaves(s.layout).find((i) => isDraft(s.panes[i]) && !s.drafts[s.panes[i]!]?.busy);
    if (open !== undefined) {
      set({ focusedPane: open });
      get().insertIntoComposer(s.panes[open]!, "");
      return;
    }
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
    // A folder that is not a git repository has no worktree to start in
    if (!d.chat && (d.worktree || d.compare) && !(await get().checkGitFolder(d.repo))) {
      get().updateDraft(id, { worktree: false, compare: null, error: t("draft.notGit") });
      return;
    }
    get().updateDraft(id, { busy: true, error: null });
    let createdId: string | undefined;
    const showSession = (record: SessionRecord) => {
      createdId = record.id;
      set((s) => {
        const cur = s.sessions[record.id] ?? { ...newView(record), historyLoaded: true };
        return {
          panes: s.panes.map((pane) => (pane === id ? record.id : pane)),
          sessions: { ...s.sessions, [record.id]: { ...cur, sendingFirstPrompt: true } },
        };
      });
    };
    try {
      try {
        if (!d.chat) localStorage.setItem(LAST_REPO_KEY, d.repo);
        localStorage.setItem(LAST_PROFILE_KEY, d.profile);
      } catch {
        // Continue even if saving fails
      }
      const title = prompt.trim().split("\n")[0].slice(0, 40) || (d.chat ? t("store.newChatTitle") : t("store.newSessionTitle"));
      const rec = d.chat
        ? await api.startChat(d.profile, title, showSession)
        : await api.startSession({ profile: d.profile, repo: d.repo, title, worktree: d.worktree }, showSession);
      if (!createdId) showSession(rec);
      // Apply the model / effort / mode chosen in the draft before the first prompt (a conversation keeps its own mode)
      const { mode: _mode, ...rest } = d.choices;
      await applyStartingChoices(rec, d.chat ? rest : d.choices, d.chat ? undefined : get().settings.default_mode);
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
      const session = createdId;
      if (session) {
        set((s) => {
          const view = s.sessions[session];
          if (!view) return s;
          // Preserve the draft and allow a retry if workspace setup or startup failed.
          return {
            panes: s.panes.map((pane) => (pane === session ? id : pane)),
            sessions: { ...s.sessions, [session]: { ...view, sendingFirstPrompt: false } },
            drafts: { ...s.drafts, [id]: { ...d, busy: false, error: String(e), retryInput: { text: prompt, attachments } } },
          };
        });
      }
      get().updateDraft(id, { busy: false, error: String(e) });
    } finally {
      const session = createdId;
      if (session) {
        set((s) => {
          const view = s.sessions[session];
          return view?.sendingFirstPrompt ? { sessions: { ...s.sessions, [session]: { ...view, sendingFirstPrompt: false } } } : s;
        });
      }
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
    await applyStartingChoices(rec);
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
    // The session takes the draft's pane as soon as its record exists, and fills in while the agent loads it
    let createdId: string | undefined;
    const showSession = (record: SessionRecord) => {
      createdId = record.id;
      set((s) => {
        const cur = s.sessions[record.id] ?? { ...newView(record), historyLoaded: true };
        return { panes: s.panes.map((pane) => (pane === draftId ? record.id : pane)), sessions: { ...s.sessions, [record.id]: cur } };
      });
    };
    try {
      const rec = await api.adoptCliSession(d.profile, d.repo, acpSessionId, title, d.worktree, showSession);
      // The conversation is the history the agent resent, copied into the log after SessionCreated
      set((s) => {
        const cur = s.sessions[rec.id] ?? newView(rec);
        const drafts = { ...s.drafts };
        delete drafts[draftId];
        return { drafts, sessions: { ...s.sessions, [rec.id]: { ...cur, record: rec, historyLoaded: false } } };
      });
      if (createdId) await loadSession(rec.id);
      else {
        const pane = leaves(get().layout).find((i) => get().panes[i] === draftId);
        await get().openInPane(rec.id, pane, `${draftId}:cli`);
      }
    } catch (e) {
      // Back to the draft with the reason, so another conversation can be picked
      const session = createdId;
      if (session) set((s) => ({ panes: s.panes.map((pane) => (pane === session ? draftId : pane)) }));
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
      // Reopen a stopped session and restore its selected effort before sending.
      const status = get().sessions[id]?.record.status;
      if (status === "closed" || status === "error") await reopenWithChoices(id);
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
      if (category === "thought_level") rememberEffort(v.record, value, true);
      return;
    }
    await api.setByCategory(id, category, value);
    if (category === "thought_level" && v) rememberEffort(v.record, value, true);
  },

  reopen: reopenWithChoices,

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
    for (const pane of [id, gitPaneOf(id), filesPaneOf(id), terminalPaneOf(id)]) {
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
    for (const pane of [id, gitPaneOf(id), filesPaneOf(id), terminalPaneOf(id)]) {
      const slot = leaves(get().layout).find((i) => get().panes[i] === pane);
      if (slot !== undefined) get().closePane(slot);
    }
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
    await applyStartingChoices(rec);
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

// Coalesce layout saves so drag updates do not write synchronously on every frame.
let layoutSaveTimer: ReturnType<typeof setTimeout> | undefined;
function saveLayout() {
  if (layoutSaveTimer === undefined) return;
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = undefined;
  const st = useStore.getState();
  const layout: Layout = {
    // Only conversation panes are restored on the next launch
    panes: st.panes.map((p) => (isDraft(p) || isPreview(p) || isGit(p) || isFiles(p) || isTerminal(p) || isCompare(p) ? null : p)),
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
}
if (typeof window !== "undefined") window.addEventListener("pagehide", saveLayout);

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
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(saveLayout, 250);
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

/**
 * Where the focus goes when a pane closes: it stays where it was, unless it was on the closed pane. Then it goes to the
 * neighbour that is left, the one before it in the layout (which takes its room), else the one after
 */
function focusAfterClose(before: LayoutNode, after: LayoutNode, closed: number, focused: number): number {
  const shown = leaves(after);
  if (focused !== closed && shown.includes(focused)) return focused;
  const order = leaves(before);
  const at = order.indexOf(closed);
  return [...order.slice(0, Math.max(at, 0)).reverse(), ...order.slice(at + 1)].find((i) => shown.includes(i)) ?? shown[0];
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
