// リポジトリを選ぶ欄: 最近使ったリポジトリと、入力の続きになるフォルダの補完
//   ↑↓ で選ぶ、Tab でそのフォルダの中へ進む（続けて補完）、⏎ で決める
import { Folder, GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, inTauri } from "@/lib/api";
import type { DirCandidate } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { Keys } from "../Keys";
import { isImeKey } from "@/lib/keys";
import { useT } from "@/i18n";

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** 最近のリポジトリ: セッションのリポジトリを新しい順に（同じものは 1 つ。セッションで使ったので git のリポジトリとみなす） */
function useRecent(current: string): DirCandidate[] {
  const sessions = useStore((s) => s.sessions);
  return useMemo(() => {
    const seen = new Set<string>();
    const out: DirCandidate[] = [];
    const list = Object.values(sessions).sort((a, b) => b.record.updated_at - a.record.updated_at);
    // 今の値は入力欄に出ているので並べない
    seen.add(current);
    for (const p of list.map((v) => v.record.repo_path)) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, name: baseName(p), git: true });
    }
    return out.slice(0, 6);
  }, [sessions, current]);
}

export function RepoPicker({ value, onPick }: { value: string; onPick: (path: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState(value);
  const [dirs, setDirs] = useState<DirCandidate[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const recent = useRecent(value);
  const touched = query !== value;

  // 入力が変わったら、少し待ってから補完を取りにいく
  useEffect(() => {
    if (!inTauri || !touched) {
      setDirs([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void api.completeDirs(query).then((d) => alive && setDirs(d)).catch(() => alive && setDirs([]));
    }, 80);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, touched]);

  // 開いた直後は最近のものだけ。打ち始めたら、名前に打った文字を含む最近のものと補完を並べる
  const q = baseName(query).toLowerCase();
  const recentShown = touched ? recent.filter((r) => r.path !== query && r.name.toLowerCase().includes(q)).slice(0, 3) : recent;
  const rows = [...recentShown.map((r) => ({ ...r, recent: true })), ...dirs.filter((d) => !recentShown.some((r) => r.path === d.path)).map((d) => ({ ...d, recent: false }))];
  const cur = Math.min(active, Math.max(0, rows.length - 1));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isImeKey(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((cur + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Tab" && !e.shiftKey && rows[cur]) {
      // そのフォルダの中へ進む
      e.preventDefault();
      setQuery(`${rows[cur].path}/`);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // 打っている途中で候補を選んでいなければ、打った値で決める
      const pick = touched && dirs.length === 0 && recentShown.length === 0 ? query : (rows[cur]?.path ?? query);
      onPick(pick.replace(/\/+$/, "") || pick);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label={t("draft.repoPath")}
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls="repo-picker-list"
        aria-activedescendant={rows[cur] ? `repo-row-${cur}` : undefined}
        autoFocus
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={onKeyDown}
        placeholder="~/projects/…"
        className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs outline-none focus:border-ring"
      />
      {rows.length > 0 && (
        <div ref={listRef} id="repo-picker-list" role="listbox" aria-label={t("draft.repoSuggestions")} className="max-h-64 overflow-y-auto">
          {rows.map((r, i) => {
            const Icon = r.git ? GitBranch : Folder;
            const head = (i === 0 && r.recent) || (!r.recent && (i === 0 || rows[i - 1].recent));
            return (
              <div key={`${r.recent ? "r" : "d"}:${r.path}`}>
                {head && <p className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">{r.recent ? t("draft.recent") : t("draft.folders")}</p>}
                <button
                  type="button"
                  role="option"
                  id={`repo-row-${i}`}
                  data-row={i}
                  aria-selected={i === cur}
                  onMouseMove={() => setActive(i)}
                  onClick={() => onPick(r.path)}
                  className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left", i === cur && "bg-accent")}
                >
                  <Icon className={cn("size-3.5 shrink-0", r.git ? "text-foreground" : "text-muted-foreground")} aria-hidden />
                  <span className="shrink-0">{r.name}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{r.path}</span>
                  {i === cur && (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
                      <Keys keys={["tab"]} />
                      <Keys keys={["enter"]} />
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
