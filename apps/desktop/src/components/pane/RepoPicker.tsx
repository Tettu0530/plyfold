// Repository picker: recent repositories plus completion of folders continuing the input
//   ↑↓ to select, Tab to descend into that folder (keeps completing), ⏎ to confirm
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Folder, FolderOpen, GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, inTauri } from "@/lib/api";
import type { DirCandidate } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore, isListed } from "@/state/store";
import { Keys } from "../Keys";
import { isImeKey } from "@/lib/keys";
import { useT } from "@/i18n";
import { isMac, isWindows } from "@/lib/platform";

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** Recent repositories: session repositories, newest first (deduplicated; used by a session, so treated as git repositories) */
function useRecent(current: string): DirCandidate[] {
  const sessions = useStore((s) => s.sessions);
  return useMemo(() => {
    const seen = new Set<string>();
    const out: DirCandidate[] = [];
    const list = Object.values(sessions)
      .filter(isListed)
      .sort((a, b) => b.record.updated_at - a.record.updated_at);
    // The current value is already in the input, so don't list it
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

  // When the input changes, wait a moment before fetching completions
  useEffect(() => {
    if (!inTauri || !touched) {
      setDirs([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void api
        .completeDirs(query)
        .then((d) => alive && setDirs(d))
        .catch(() => alive && setDirs([]));
    }, 80);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, touched]);

  // Right after opening, only recent ones. Once typing starts, list recent ones whose name contains the text, plus completions
  const q = baseName(query).toLowerCase();
  const recentShown = touched ? recent.filter((r) => r.path !== query && r.name.toLowerCase().includes(q)).slice(0, 3) : recent;
  const rows = [
    ...recentShown.map((r) => ({ ...r, recent: true })),
    ...dirs.filter((d) => !recentShown.some((r) => r.path === d.path)).map((d) => ({ ...d, recent: false })),
  ];
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
      // Descend into that folder
      e.preventDefault();
      setQuery(`${rows[cur].path}/`);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // If no candidate was selected while typing, confirm with the typed value
      const pick = touched && dirs.length === 0 && recentShown.length === 0 ? query : (rows[cur]?.path ?? query);
      onPick(pick.replace(/\/+$/, "") || pick);
    }
  };

  // The system's folder chooser (Finder, File Explorer), starting from the folder in the input when it is a full path
  const browse = async () => {
    const start = query.replace(/\/+$/, "");
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("draft.browseTitle"),
      defaultPath: start.startsWith("/") || /^[A-Za-z]:[\\/]/.test(start) ? start : undefined,
    }).catch(() => null);
    if (typeof picked === "string" && picked) onPick(picked);
  };
  const browseLabel = t(isMac ? "draft.browseMac" : isWindows ? "draft.browseWindows" : "draft.browseLinux");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
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
          className="h-8 min-w-0 grow rounded-md border border-input bg-transparent px-2 font-mono text-xs outline-none focus:border-ring"
        />
        {inTauri && (
          <button
            type="button"
            aria-label={browseLabel}
            title={browseLabel}
            onClick={() => void browse()}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
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
