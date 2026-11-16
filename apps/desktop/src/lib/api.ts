import { invoke } from "@tauri-apps/api/core";
import type { AttachmentWire } from "./attachments";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Category, CheckResult, Diff, EngineEvent, EventRecord, ProfileDetail, ProfileForm, ProfileSummary, SessionInfo, SessionRecord, SettingsView, WtStatus, AppSettings } from "./types";

// Tauri のコマンド（src-tauri/src/lib.rs）の薄い包み。引数名は Rust 側の camelCase 変換に合わせる
export const api = {
  listProfiles: () => invoke<ProfileSummary[]>("list_profiles"),
  listSessions: () => invoke<SessionRecord[]>("list_sessions"),
  sessionHistory: (id: string) => invoke<EventRecord[]>("session_history", { id }),
  startSession: (args: { profile: string; repo: string; title: string; worktree: boolean }) =>
    invoke<SessionRecord>("start_session", args),
  reopenSession: (id: string) => invoke<void>("reopen_session", { id }),
  renameSession: (id: string, title: string) => invoke<void>("rename_session", { id, title }),
  closeSession: (id: string) => invoke<void>("close_session", { id }),
  deleteSession: (id: string, removeWorktree: boolean) => invoke<void>("delete_session", { id, removeWorktree }),
  prompt: (id: string, text: string, attachments: AttachmentWire[] = []) => invoke<void>("prompt", { id, text, attachments }),
  cancel: (id: string) => invoke<void>("cancel", { id }),
  respondPermission: (id: string, permissionId: string, optionId: string | null) =>
    invoke<void>("respond_permission", { id, permissionId, optionId }),
  setByCategory: (id: string, category: Category, value: string) =>
    invoke<void>("set_by_category", { id, category, value }),
  sessionInfo: (id: string) => invoke<SessionInfo | null>("session_info", { id }),
  sessionDiff: (id: string) => invoke<Diff>("session_diff", { id }),
  worktreeStatus: (id: string) => invoke<WtStatus>("worktree_status", { id }),
  commitSession: (id: string, message: string) => invoke<string>("commit_session", { id, message }),
  mergeSession: (id: string) => invoke<{ target: string; cleaned: boolean }>("merge_session", { id }),
  getSettings: () => invoke<SettingsView>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  revealPath: (which: "config" | "data") => invoke<void>("reveal_path", { which }),
  createPr: (id: string) => invoke<string>("create_pr", { id }),
  openInEditor: (id: string) => invoke<string>("open_in_editor", { id }),
  discardSessionChanges: (id: string) => invoke<void>("discard_session_changes", { id }),
  profileDetail: (name: string) => invoke<ProfileDetail>("profile_detail", { name }),
  saveProfile: (form: ProfileForm, original: string | null) => invoke<void>("save_profile", { form, original }),
  setProfileKey: (name: string, value: string) => invoke<void>("set_profile_key", { name, value }),
  deleteProfile: (name: string) => invoke<void>("delete_profile", { name }),
  checkProfile: (name: string) => invoke<CheckResult>("check_profile", { name }),
};

export function onEngineEvent(handler: (e: EngineEvent) => void): Promise<UnlistenFn> {
  return listen<EngineEvent>("engine", (msg) => handler(msg.payload));
}

/** Tauri の外（ブラウザでの開発）では invoke が使えない */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
