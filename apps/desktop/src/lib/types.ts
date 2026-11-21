// Types matching the serde shapes on the Rust side (plyfold-core / plyfold-store)

export type SessionStatus = "starting" | "idle" | "working" | "awaiting_permission" | "stalled" | "error" | "closed";

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
  /** A side chat: the session it was forked from (read-only, not listed, deleted when closed) */
  side_of?: string | null;
  /** The profile that reviews this session after each turn */
  reviewer?: string | null;
  /** A side session that reviews the session in side_of */
  review?: boolean;
  /** When it was moved to the trash (ms); trashed sessions stay out of the list until restored */
  trashed_at?: number | null;
  /** The port its dev servers get (PORT in the agent's environment) */
  port?: number | null;
  /** Sessions started together from one prompt to compare share this id */
  run_group?: string | null;
  /** An everyday conversation (no repository; it may look things up but not edit or run commands) */
  chat?: boolean;
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
  | { type: "renamed"; session_id: string; title: string }
  /** Where the session works changed (its worktree folder was removed, so it continues in the repository) */
  | { type: "workspace_changed"; session: SessionRecord }
  /** A prompt stopped by a usage limit goes out again at `at` (ms); null when that is no longer planned */
  | { type: "resume_scheduled"; session_id: string; at: number | null };

/** A conversation the CLI already has, which Plyfold has not recorded */
export interface CliSession {
  acp_session_id: string;
  title: string | null;
  updated_at: string | null;
}

export interface EventRecord {
  id: number;
  session_id: string;
  ts: number;
  kind: "frame_in" | "frame_out" | "fork_in" | "fork_out" | "status" | "note";
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
  /** Name of the sidebar group for everyday conversations ("" = the default) */
  chat_group_name?: string;
  /** How many queued tasks may run at once */
  max_parallel?: number;
  /** Send a prompt stopped by a usage limit again, with the same key, when the limit lifts */
  resume_after_limit?: boolean;
}

/** Settings → Info (src-tauri app_info) */
export interface AppInfo {
  version: string;
  license: string;
  repository: string;
  tauri: string;
  /** "macOS" / "Windows" */
  os_name: string;
  os: string | null;
  arch: string;
  agents: { id: string; command: string }[];
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

/** crates/plyfold-worktree/src/remote.rs */
export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  time: number;
  pushed: boolean;
}

export interface GitInfo {
  branch: string | null;
  base: string | null;
  ahead_base: number;
  behind_base: number;
  upstream: string | null;
  /** The upstream it was pushed to, since deleted on the remote (typically after its PR was merged) */
  upstream_gone: string | null;
  ahead: number;
  behind: number;
  changed: number;
  commits: GitCommit[];
  remote_url: string | null;
  web_url: string | null;
  fetched_at: number | null;
}

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED" | string;
  draft: boolean;
  review: string | null;
  checks: { passed: number; failed: number; pending: number };
}

export interface Diff {
  files: FileStat[];
  patch: string;
}

export type AuthKind = "login" | "api" | "custom";

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerForm {
  transport: McpTransport;
  name: string;
  command: string;
  args: string[];
  url: string;
}

export interface ProfileForm {
  name: string;
  agent: string;
  label: string | null;
  auth: AuthKind;
  base_url: string | null;
  isolate: boolean;
  mcp: McpServerForm[];
  /** Profile to continue with when this one's key hits a rate or usage limit (same agent) */
  fallback?: string | null;
  /** Model name to send instead of the agent's own (a custom provider often has names of its own) */
  model?: string | null;
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
  /** Uses a key billed by use, so it can be another profile's fallback (not a sign-in or subscription token) */
  uses_key: boolean;
  custom_provider: boolean;
  /** Name of an agent added from the ACP Registry (built-in agents are named by the UI) */
  agent_name?: string | null;
  /** Its icon (SVG text), kept when it was added */
  agent_icon?: string | null;
}

/** An agent in the ACP Registry (src-tauri/src/registry.rs) */
export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository: string | null;
  website: string | null;
  license: string | null;
  kind: "npx" | "uvx" | "binary";
  /** Can be added (not built in, and for a binary: a build for this system with a checksum) */
  addable: boolean;
  /** Why a binary cannot be added */
  unavailable: "platform" | "checksum" | null;
  /** The built-in agent it is, if any */
  built_in: string | null;
  /** The version added, if it was */
  added: string | null;
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
/** Per repository (Settings → Repositories): what a new worktree gets, and the kinds allowed without asking */
export interface RepoSettings {
  /** Name of its group in the sidebar ("" = the folder's name) */
  name: string;
  setup: string;
  copy: string[];
  /** "read" | "edit" | "execute" | "fetch" */
  allow: string[];
}

export interface RepoEntry {
  path: string;
  settings: RepoSettings;
}

/** A prompt waiting to start as a session (the task queue) */
export interface QueuedTask {
  id: string;
  profile: string;
  repo: string;
  worktree: boolean;
  prompt: string;
  title: string;
  created_at: number;
  /** Why it could not start; it then waits until started again by hand */
  error?: string | null;
}

/** A file's contents for the touched-files pane (read_text_file) */
export interface TextFile {
  /** null for a binary file */
  text: string | null;
  size: number;
  /** Only the first MiB was read */
  truncated: boolean;
}

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
