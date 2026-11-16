// プロファイルごとに、前回のセッションの設定項目（model / effort / mode の候補と値）とコンテキストの大きさを覚えておく。
// 新しいセッションの下書きで、起動する前から同じ操作を出すため。この端末の中だけの便利機能なので localStorage に置く
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
    // 保存できなくても動く（次の下書きで候補が出ないだけ）
  }
}

/** 覚えておく形: 設定項目と大きさだけ。使用量や途中経過は捨てる */
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
  };
}

/** 下書きで選んだ値を、覚えている設定項目に重ねる */
export function withChoices(info: SessionInfo, choices: Partial<Record<string, string>>): SessionInfo {
  return {
    ...info,
    config: info.config.map((o) => (choices[o.category] ? { ...o, current: choices[o.category]! } : o)),
    current_mode: choices.mode ?? info.current_mode,
  };
}
