// Rust 側（plyfold-core / plyfold-store）の serde の形に合わせた型

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
}

export interface PermissionChoice {
  option_id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

// session/update の update 部分（生の JSON）
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
  | { type: "info"; session_id: string; info: SessionInfo };

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

export interface Diff {
  files: FileStat[];
  patch: string;
}

export interface ProfileSummary {
  name: string;
  agent: string;
  label: string;
  isolate: boolean;
  keyed: boolean;
  custom_provider: boolean;
}
