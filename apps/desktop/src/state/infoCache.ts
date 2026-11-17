// Remember, per profile, the last session's config options (model / effort / mode choices and values) and context size,
// so a new session draft can show the same controls before the agent starts. A local convenience only, so it lives in localStorage
import type { SessionInfo } from "@/lib/types";

const KEY = "plyfold.infoCache.v1";

export type InfoCache = Record<string, SessionInfo>;

export function loadInfoCache(): InfoCache {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as InfoCache) : {};
  } catch {
    return {};
  }
}

export function saveInfoCache(cache: InfoCache) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Works even if saving fails (the next draft just won't show options)
  }
}

/** What gets stored: config options and size only. Usage and progress are dropped */
export function snapshot(info: SessionInfo): SessionInfo {
  return {
    config: info.config,
    modes: info.modes,
    current_mode: info.current_mode,
    context_used: 0,
    context_size: info.context_size,
    cost: null,
    reported_model: null,
    last_turn: null,
    total: { input: 0, output: 0, cached_read: 0, cached_write: 0, thought: 0, total: 0 },
    live: null,
    commands: info.commands ?? [],
  };
}

/** Overlay values chosen in the draft onto the remembered config options */
export function withChoices(info: SessionInfo, choices: Partial<Record<string, string>>): SessionInfo {
  return {
    ...info,
    config: info.config.map((o) => (choices[o.category] ? { ...o, current: choices[o.category]! } : o)),
    current_mode: choices.mode ?? info.current_mode,
  };
}
