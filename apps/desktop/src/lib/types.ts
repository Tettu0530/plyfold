// Types matching the serde shapes on the Rust side (plyfold-core / plyfold-store)

export type SessionStatus =
  | "starting"
  | "idle"
  | "working"
  | "awaiting_permission"
  | "stalled"
  | "error"
  | "closed";

export interface SessionRecord {
  id: string;
  title: string;
  profile: string;
  agent: string;
  repo_path: string | null;
  worktree_path: string | null;
  branch: string | null;
  base_ref: string | null;
  acp_session_id: string | null;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
}

export type Category = "model" | "thought_level" | "mode" | "other";

export interface Choice {
  value: string;
  name: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  category: Category;
  current: string | null;
  choices: Choice[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cached_read: number;
  cached_write: number;
  thought: number;
  total: number;
}

export interface TurnStats {
  usage: TokenUsage | null;
  elapsed_ms: number;
  ttft_ms: number | null;
  tokens_per_sec: number | null;
  estimated: boolean;
}

export interface LiveTurn {
  elapsed_ms: number;
  ttft_ms: number | null;
  streamed_chars: number;
  est_tokens_per_sec: number | null;
}

export interface SessionInfo {
  config: ConfigOption[];
  modes: Choice[];
  current_mode: string | null;
  context_used: number | null;
  context_size: number | null;
  cost: { amount: number; currency: string } | null;
  reported_model: string | null;
  last_turn: TurnStats | null;
  total: TokenUsage;
  live: LiveTurn | null;
  /** Slash commands the agent offers (missing in info remembered by older versions) */
  commands?: SlashCommand[];
}

export interface SlashCommand {
  name: string;
  description: string;
  hint: string | null;
}

export interface PermissionChoice {
  option_id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

// The update part of session/update (raw JSON)
export type AcpUpdate = { sessionUpdate: string } & Record<string, unknown>;

export type EngineEvent =
  | { type: "session_created"; session: SessionRecord }
  | { type: "status"; session_id: string; status: SessionStatus }
  | { type: "update"; session_id: string; update: AcpUpdate }
  | {
      type: "permission_requested";
      session_id: string;
      permission_id: string;
      title: string;
      tool_call: Record<string, unknown>;
      options: PermissionChoice[];
    }
  | { type: "permission_resolved"; session_id: string; permission_id: string; option_id: string | null }
  | { type: "turn_ended"; session_id: string; stop_reason: string | null; error: string | null }
  | { type: "notice"; session_id: string; message: string }
  | { type: "info"; session_id: string; info: SessionInfo }
  | { type: "renamed"; session_id: string; title: string };

export interface EventRecord {
  id: number;
  session_id: string;
  ts: number;
  kind: "frame_in" | "frame_out" | "status" | "note";
  payload: string;
}

export interface FileStat {
  path: string;
  added: number;
  removed: number;
  untracked: boolean;
  binary: boolean;
}

export type EditorChoice = "auto" | "zed" | "cursor" | "code" | "finder";

export interface AppSettings {
  editor: EditorChoice;
  cleanup_after_merge: boolean;
  stall_seconds: number;
  worktree_default: boolean;
  /** Key that sends from the input box */
  send_key: "enter" | "cmd_enter";
  /** UI language (auto follows macOS) */
  language: "auto" | "ja" | "en" | "zh";
  /** Sidebar density */
  sidebar_density: "comfortable" | "compact";
  /** Notify when a turn finishes in a session you are not looking at */
  notify_turn_end: boolean;
  /** Notify when an agent asks for permission in a session you are not looking at */
  notify_permission: boolean;
  /** Changed keyboard shortcuts (action → combo; "" unbinds). See lib/keymap.ts */
  keybindings: Record<string, string>;
  /** Size of the whole UI in percent */
  ui_scale: number;
  /** "system" follows macOS Reduce motion */
  reduce_motion: "system" | "reduce";
  /** Show the agent's thinking expanded */
  thoughts_expanded: boolean;
  /** Reopen the sessions that were in panes when the app quit */
  restore_panes: boolean;
  /** Profile for new sessions ("" = the one used last) */
  default_profile: string;
}

export interface SettingsView {
  settings: AppSettings;
  config_path: string;
  state_dir: string;
}

export interface WtStatus {
  dirty: boolean;
  commits: number;
  target: string | null;
  merged: boolean;
}

export interface Diff {
  files: FileStat[];
  patch: string;
}

export type AuthKind = "login" | "api" | "custom";

export interface ProfileForm {
  name: string;
  agent: string;
  label: string | null;
  auth: AuthKind;
  base_url: string | null;
  isolate: boolean;
}

export interface ProfileDetail {
  form: ProfileForm;
  supported: AuthKind[];
  key_var: string | null;
  key_account: string | null;
  key_set: boolean;
  key_tail: string | null;
  shared_with: string[];
  config_dir_env: string | null;
}

export interface CheckResult {
  ok: boolean;
  first_text_ms: number | null;
  total_ms: number;
  reply: string;
  reported_model: string | null;
  configured_model: string | null;
  error: string | null;
  at: number;
}

export interface ProfileSummary {
  name: string;
  agent: string;
  label: string;
  isolate: boolean;
  keyed: boolean;
  custom_provider: boolean;
}

/** Per-profile usage (crates/plyfold-core/src/usage.rs) */
export interface ProfileUsage {
  profile: string;
  agent: string;
  sessions: number;
  turns: number;
  input: number | null;
  output: number | null;
  cost: number | null;
  currency: string | null;
  last_used: number | null;
}

/** Completion candidates for the repository picker (apps/desktop/src-tauri/src/dirs.rs) */
/** A file offered for an @-mention (apps/desktop/src-tauri/src/files.rs) */
export interface FileHit {
  /** Relative to the session's working directory */
  path: string;
  abs: string;
}

export interface DirCandidate {
  path: string;
  name: string;
  git: boolean;
}
