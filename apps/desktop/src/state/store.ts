// 画面の状態。エンジンのイベントをここで受けて、セッションごとの表示用の形にする

import { create } from "zustand";

import type { LiquidStyle } from "@/components/liquid/liquid";
import { api, inTauri, onEngineEvent } from "@/lib/api";
import type { Category, EngineEvent, ProfileSummary, SessionInfo, SessionRecord } from "@/lib/types";
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
}

export type PaneCount = 1 | 2 | 4;

interface State {
  sessions: Record<string, SessionView>;
  profiles: ProfileSummary[];
  panes: (string | null)[];
  paneCount: PaneCount;
  focusedPane: number;
  searchOpen: boolean;
  newSessionOpen: boolean;
  labOpen: boolean;
  /** 分離アニメーションの型（動きの調整で選ぶ） */
  liquidStyle: LiquidStyle;
  ready: boolean;

  init: () => Promise<void>;
  setPaneCount: (n: PaneCount) => void;
  openInPane: (id: string, pane?: number) => Promise<void>;
  closePane: (pane: number) => void;
  focusPane: (pane: number) => void;
  setSearchOpen: (open: boolean) => void;
  setNewSessionOpen: (open: boolean) => void;
  setLabOpen: (open: boolean) => void;
  setLiquidStyle: (s: LiquidStyle) => void;
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
});

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
  profiles: [],
  panes: [null, null, null, null],
  paneCount: 2,
  focusedPane: 0,
  searchOpen: false,
  newSessionOpen: false,
  labOpen: false,
  liquidStyle: "pop",
  ready: false,

  init: async () => {
    if (!inTauri || get().ready) return;
    await onEngineEvent((e) => set((s) => ({ sessions: reduceEvent(s.sessions, e) })));
    const [profiles, records] = await Promise.all([api.listProfiles(), api.listSessions()]);
    const sessions: Record<string, SessionView> = {};
    for (const r of records) sessions[r.id] = newView(r);
    set({ profiles, sessions, ready: true });
  },

  setPaneCount: (paneCount) => set((s) => ({ paneCount, focusedPane: Math.min(s.focusedPane, paneCount - 1) })),

  openInPane: async (id, pane) => {
    const s = get();
    const already = s.panes.slice(0, s.paneCount).indexOf(id);
    if (already >= 0) {
      set({ focusedPane: already });
    } else {
      const target = pane ?? firstFreePane(s.panes, s.paneCount, s.focusedPane);
      const panes = [...s.panes];
      panes[target] = id;
      set({ panes, focusedPane: target });
    }
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

  closePane: (pane) =>
    set((s) => {
      const panes = [...s.panes];
      panes[pane] = null;
      return { panes };
    }),

  focusPane: (focusedPane) => set({ focusedPane }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
  setLabOpen: (labOpen) => set({ labOpen }),
  setLiquidStyle: (liquidStyle) => set({ liquidStyle }),

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
      if (status === "closed" || status === "error") await api.reopenSession(id);
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
