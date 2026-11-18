import { ArrowLeft, ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { parsePatch, toSplit, type FilePatch, type PatchLine } from "@/lib/patch";
import type { Diff, FileStat, WtStatus } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT, type MessageKey } from "@/i18n";
import { gitSessionOf, useStore } from "@/state/store";
import { Num, ROW, Unified } from "../PatchLines";
import { Segmented } from "../Segmented";
import { GitPanel, useGitInfo } from "./GitMenu";
import { startDrag } from "./dnd";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";

type View = "unified" | "split";

const BADGE: Record<FilePatch["status"], { letter: string; className: string; label: MessageKey }> = {
  added: { letter: "A", className: "text-working", label: "diff.badgeAdded" },
  deleted: { letter: "D", className: "text-error", label: "diff.badgeDeleted" },
  modified: { letter: "M", className: "text-muted-foreground", label: "diff.badgeModified" },
  renamed: { letter: "R", className: "text-muted-foreground", label: "diff.badgeRenamed" },
};

/** Below this pane width the Git pane shows one column: the list, or one file's diff */
const NARROW_PX = 720;

function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [w, setW] = useState(1000);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    setW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

type FileRow = { stat: FileStat; patch: FilePatch | undefined };

/**
 * Git and the changes of a session, as a pane (it opens next to the session's pane, out of its Git button).
 * Wide: the branch, remote, commits and changed files in a resizable column, the selected file's diff beside it.
 * Narrow: one column, the list, and a file's diff in its place once picked. Bottom (worktree sessions): commit,
 * merge, discard and pull requests
 */
export function GitPane({ index, id }: { index: number; id: string }) {
  const t = useT();
  const sid = gitSessionOf(id);
  const view = useStore((s) => s.sessions[sid]);
  const focused = useStore((s) => s.focusedPane === index);
  const { focusPane, closePane, bumpDiff } = useStore.getState();
  const diffVersion = useStore((s) => s.diffVersion);
  const pane = useRef<HTMLElement>(null);
  const width = useWidth(pane);
  const narrow = width < NARROW_PX;
  const [data, setData] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  // Narrow: whether a file's diff replaces the list
  const [reading, setReading] = useState(false);
  const [mode, setMode] = useState<View>("unified");
  const [wt, setWt] = useState<WtStatus | null>(null);
  const status = view?.record.status;
  const busy = status === "working" || status === "awaiting_permission" || status === "starting" || status === "stalled";
  const git = useGitInfo(sid, busy);
  const [columnWidth, setColumnWidth] = useColumnWidth();

  // The worktree status exists only for worktree sessions (one in the repository itself has no actions here)
  const reload = () =>
    Promise.all([
      api.sessionDiff(sid).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e) => setError(String(e)),
      ),
      api.worktreeStatus(sid).then(setWt, () => setWt(null)),
    ]).then(() => {});

  // On open, after worktree actions and status changes, when the window comes back, and every few seconds while the
  // agent works (it edits files mid-turn)
  useEffect(() => {
    void reload();
    window.addEventListener("focus", reload);
    const timer = busy ? setInterval(reload, 5000) : undefined;
    return () => {
      window.removeEventListener("focus", reload);
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, status, busy, diffVersion]);

  const files: FileRow[] = useMemo(() => {
    if (!data) return [];
    const parsed = parsePatch(data.patch);
    // Counts come from the engine (--numstat); lines come from the patch
    return data.files.map((f) => ({ stat: f, patch: parsed.find((p) => p.path === f.path) }));
  }, [data]);
  const total = files.reduce((a, f) => ({ add: a.add + f.stat.added, del: a.del + f.stat.removed }), { add: 0, del: 0 });

  if (!view) {
    return (
      <section ref={pane} className="flex min-w-0 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <p>{t("diff.sessionGone")}</p>
        <button type="button" onClick={() => closePane(index)} className="rounded-md px-2 py-1 hover:bg-accent hover:text-foreground">
          {t("pane.closePane")}
        </button>
      </section>
    );
  }
  const r = view.record;
  const current = files[Math.min(sel, files.length - 1)];
  const empty =
    data && files.length === 0 ? (
      <p className="p-4 text-xs text-muted-foreground">{r.base_ref ? t("diff.noChangesSince", { base: r.base_ref.slice(0, 7) }) : t("diff.noChanges")}</p>
    ) : null;

  const list = (
    <>
      <section aria-label={t("pane.git")} className="border-b px-2 pt-3 pb-3">
        <GitPanel key={sid} id={sid} git={git} busy={busy} title={r.title} />
      </section>
      <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-xs">
        <span className="font-medium text-muted-foreground">{data ? t("diff.changedFilesCount", { count: files.length }) : t("diff.loading")}</span>
        <span className="grow" />
        {data && (
          <span className="font-mono tabular">
            <span className="text-working">+{total.add}</span> <span className="text-error">−{total.del}</span>
          </span>
        )}
      </div>
      <FileList
        files={files}
        sel={narrow ? -1 : sel}
        onPick={(i) => {
          setSel(i);
          if (narrow) setReading(true);
        }}
      />
      {narrow && error && <p className="p-4 text-xs whitespace-pre-wrap text-error">{t("diff.loadFailed", { error })}</p>}
      {narrow && empty}
    </>
  );

  return (
    <section
      ref={pane}
      aria-label={t("diff.dialogLabel", { title: r.title })}
      onMouseDown={() => focusPane(index)}
      className={cn("@container flex min-w-0 flex-col", focused && "bg-white/[0.01]")}
    >
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(e) => startDrag(e, () => ({ kind: "pane", slot: index, title: `Git: ${r.title}`, agent: r.agent }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b pr-1.5 pl-3"
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{r.title}</span>
          {git.info?.branch && <span className="hidden truncate font-mono text-xs text-muted-foreground @[26rem]:inline">{git.info.branch}</span>}
          <span className="grow" />
          {data && total.add + total.del > 0 && (
            <span className="shrink-0 font-mono text-xs tabular">
              <span className="text-working">+{total.add}</span> <span className="text-error">−{total.del}</span>
            </span>
          )}
          <button
            type="button"
            aria-label={t("pane.closePane")}
            onClick={() => closePane(index)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </PaneMenu>

      {narrow ? (
        // One column: the list, or the picked file's diff in its place
        reading && current ? (
          <FileDiff file={current} mode="unified" onBack={() => setReading(false)} />
        ) : (
          <div className="flex min-h-0 grow flex-col overflow-y-auto">{list}</div>
        )
      ) : (
        <div className="flex min-h-0 grow">
          {/* One scroll for the Git section and the file list */}
          <div className="relative flex shrink-0" style={{ width: Math.min(columnWidth, Math.round(width * 0.6)) }}>
            <aside aria-label={t("diff.changedFilesLabel")} className="flex min-w-0 grow flex-col overflow-y-auto border-r">
              {list}
            </aside>
            <ColumnResizer width={columnWidth} onChange={setColumnWidth} />
          </div>
          <div className="flex min-w-0 grow flex-col">
            {error && <p className="p-4 text-xs whitespace-pre-wrap text-error">{t("diff.loadFailed", { error })}</p>}
            {empty}
            {current && <FileDiff file={current} mode={mode} onMode={setMode} />}
          </div>
        </div>
      )}

      {wt && (
        <Actions
          key={sid}
          id={sid}
          title={r.title}
          status={wt}
          busy={busy}
          onDone={() => {
            bumpDiff();
            void git.refresh();
            return reload();
          }}
        />
      )}
    </section>
  );
}

function FileList({ files, sel, onPick }: { files: FileRow[]; sel: number; onPick: (i: number) => void }) {
  const t = useT();
  return (
    <div role="listbox" aria-label={t("diff.filesLabel")} className="flex flex-col gap-0.5 px-2 pb-2">
      {files.map((f, i) => {
        const b = BADGE[f.patch?.status ?? (f.stat.untracked ? "added" : "modified")];
        return (
          <button
            key={f.stat.path}
            type="button"
            role="option"
            aria-selected={i === sel}
            onClick={() => onPick(i)}
            className={cn("flex h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 hover:bg-accent", i === sel && "bg-muted")}
          >
            <span title={t(b.label)} className={cn("w-4 shrink-0 font-mono text-xs font-medium", b.className)}>
              {b.letter}
            </span>
            <span className="min-w-0 grow truncate text-left font-mono text-xs" title={f.stat.path}>
              {f.stat.path}
            </span>
            <span className="flex shrink-0 gap-1.5 font-mono text-xs tabular">
              {f.stat.binary ? (
                <span className="text-muted-foreground">bin</span>
              ) : (
                <>
                  <span className="text-working">+{f.stat.added}</span>
                  <span className="text-error">−{f.stat.removed}</span>
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** One file's diff: its path and counts, then the lines. With onBack (narrow), a way back to the list */
function FileDiff({ file, mode, onMode, onBack }: { file: FileRow; mode: View; onMode?: (v: View) => void; onBack?: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md pr-2 pl-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {t("diff.backToFiles")}
          </button>
        )}
        <span className={cn("min-w-0 truncate font-mono text-xs", !onBack && "pl-2")} title={file.stat.path}>
          {file.stat.path}
        </span>
        <span className="shrink-0 font-mono text-xs tabular">
          <span className="text-working">+{file.stat.added}</span> <span className="text-error">−{file.stat.removed}</span>
        </span>
        <span className="grow" />
        {onMode && (
          <Segmented<View>
            label={t("diff.viewLabel")}
            value={mode}
            onChange={onMode}
            options={[
              { value: "unified", label: t("diff.viewUnified") },
              { value: "split", label: t("diff.viewSplit") },
            ]}
          />
        )}
      </div>
      <div className="min-h-0 grow overflow-auto py-1 font-mono text-xs leading-5">
        {file.stat.binary || file.patch?.binary ? (
          <p className="px-4 py-2 text-muted-foreground">{t("diff.binaryFile")}</p>
        ) : !file.patch ? (
          <p className="px-4 py-2 text-muted-foreground">{t("diff.noPatchLines")}</p>
        ) : mode === "unified" ? (
          <Unified lines={file.patch.lines} />
        ) : (
          <Split lines={file.patch.lines} />
        )}
      </div>
    </div>
  );
}

const COLUMN_DEFAULT = 340;
const COLUMN_MIN = 260;
const COLUMN_KEY = "plyfold.gitColumnWidth";
const clampColumn = (w: number) => Math.round(Math.min(Math.max(w, COLUMN_MIN), Math.max(COLUMN_MIN, window.innerWidth * 0.6)));

/** The left column's width, remembered on this machine (a viewer convenience, so local storage is enough) */
function useColumnWidth(): [number, (w: number) => void] {
  const [w, setW] = useState(() => {
    try {
      const v = Number(localStorage.getItem(COLUMN_KEY));
      return v > 0 ? clampColumn(v) : COLUMN_DEFAULT;
    } catch {
      return COLUMN_DEFAULT;
    }
  });
  const set = (v: number) => {
    const c = clampColumn(v);
    setW(c);
    try {
      localStorage.setItem(COLUMN_KEY, String(c));
    } catch {
      // Not remembered, still applied
    }
  };
  return [w, set];
}

/** The left column's right edge: drag to resize, double-click or Enter for the default width, arrow keys to nudge */
function ColumnResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const t = useT();
  const drag = useRef<{ left: number } | null>(null);
  const [active, setActive] = useState(false);
  const end = () => {
    drag.current = null;
    document.body.classList.remove("resizing");
    setActive(false);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("diff.resizeColumn")}
      aria-valuenow={width}
      aria-valuemin={COLUMN_MIN}
      title={t("diff.resizeColumnHint")}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic events have no capturable pointer
        }
        drag.current = { left: e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0 };
        document.body.classList.add("resizing");
        setActive(true);
      }}
      onPointerMove={(e) => drag.current && onChange(e.clientX - drag.current.left)}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(COLUMN_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 8;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onChange(width + (e.key === "ArrowLeft" ? -step : step));
        } else if (e.key === "Enter") onChange(COLUMN_DEFAULT);
      }}
      className="group absolute top-0 -right-1 bottom-0 z-10 flex w-2 cursor-col-resize justify-center outline-none"
    >
      <span
        aria-hidden
        className={cn(
          "h-full w-0.5 bg-foreground/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
          active && "opacity-100",
        )}
      />
    </div>
  );
}

/** Actions at the bottom of the diff screen: commit, merge, discard */
function Actions({ id, title, status, busy, onDone }: { id: string; title: string; status: WtStatus; busy: boolean; onDone: () => Promise<void> }) {
  const t = useT();
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState(title);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmPr, setConfirmPr] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const target = status.target ?? t("diff.originalBranch");
  const nothing = !status.dirty && status.commits === 0;

  const run = async (f: () => Promise<string>) => {
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      setDone(await f());
      setComposing(false);
      setConfirmDiscard(false);
      setConfirmPr(false);
      await onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };
  const commit = () => run(async () => t("diff.committed", { hash: await api.commitSession(id, message) }));
  const merge = () =>
    run(async () => {
      const r = await api.mergeSession(id);
      if (r.cleaned) await useStore.getState().reloadSessions();
      return r.cleaned ? t("diff.mergedAndCleaned", { target: r.target }) : t("diff.merged", { target: r.target });
    });
  const pr = () => run(async () => t("diff.prCreated", { url: await api.createPr(id) }));
  const openEditor = async () => {
    setError(null);
    try {
      setDone(t("diff.openedIn", { editor: await api.openInEditor(id) }));
    } catch (e) {
      setError(String(e));
    }
  };
  const discard = () =>
    run(async () => {
      await api.discardSessionChanges(id);
      return t("diff.discarded");
    });

  const summary = status.dirty
    ? t("diff.uncommitted")
    : status.merged
      ? t("diff.alreadyMerged", { target })
      : status.commits > 0
        ? t("diff.commitsNotMerged", { count: status.commits, target })
        : t("diff.noChanges");

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t px-4 py-3">
      {composing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }}
        >
          <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            aria-label={t("diff.commitMessageLabel")}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            autoFocus
            className="h-8 grow text-sm"
          />
          <button type="button" onClick={() => setComposing(false)} className="h-8 rounded-lg px-3 text-muted-foreground hover:bg-accent hover:text-foreground">
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={running || !message.trim()}
            className="h-8 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {t("diff.commit")}
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void openEditor()} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
            <ExternalLink className="size-3.5" aria-hidden />
            {t("diff.openInEditor")}
          </button>
          {!status.dirty &&
            status.commits > 0 &&
            (confirmPr ? (
              <button
                type="button"
                disabled={running || busy}
                onClick={() => void pr()}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent disabled:opacity-40"
              >
                <GitPullRequest className="size-3.5" aria-hidden />
                {t("diff.pushAndCreatePr")}
              </button>
            ) : (
              <button
                type="button"
                disabled={running || busy}
                onClick={() => setConfirmPr(true)}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent disabled:opacity-40"
              >
                <GitPullRequest className="size-3.5" aria-hidden />
                {t("diff.createPr")}
              </button>
            ))}
          {/* Narrow: the status takes its own line above the buttons */}
          <span className="order-first basis-full text-xs text-muted-foreground @[44rem]:order-none @[44rem]:basis-auto @[44rem]:pl-2">
            {busy ? t("diff.busyDuringTurn") : summary}
          </span>
          <span className="grow" />
          {!nothing &&
            (confirmDiscard ? (
              <button
                type="button"
                disabled={running || busy}
                onClick={() => void discard()}
                className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-error hover:bg-error/10 disabled:opacity-40"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t("diff.discardWithCommits")}
              </button>
            ) : (
              <button
                type="button"
                disabled={running || busy}
                onClick={() => setConfirmDiscard(true)}
                className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-error hover:bg-error/10 disabled:opacity-40"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t("diff.discard")}
              </button>
            ))}
          {status.dirty ? (
            <button
              type="button"
              disabled={running || busy}
              onClick={() => setComposing(true)}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              <GitCommitHorizontal className="size-3.5" aria-hidden />
              {t("diff.commitEllipsis")}
            </button>
          ) : (
            status.commits > 0 &&
            !status.merged && (
              <button
                type="button"
                disabled={running || busy || !status.target}
                title={status.target ? undefined : t("diff.noTargetBranch")}
                onClick={() => void merge()}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                <GitMerge className="size-3.5" aria-hidden />
                {t("diff.mergeInto", { target })}
              </button>
            )
          )}
        </div>
      )}
      {done && !error && <p className="text-xs text-muted-foreground select-text">{done}</p>}
      {error && <p className="text-xs whitespace-pre-wrap text-error">{error}</p>}
    </div>
  );
}

function Split({ lines }: { lines: PatchLine[] }) {
  const rows = toSplit(lines);
  const cell = (l: PatchLine | null, side: "old" | "new") => (
    <div className={cn("flex min-w-0 pr-3 pl-1", l ? ROW[l.kind] : "bg-card/40")}>
      <Num n={l ? l[side] : null} />
      <span className="min-w-0 overflow-hidden whitespace-pre">{l?.text ?? ""}</span>
    </div>
  );
  return (
    <div>
      {rows.map((r, i) =>
        r.kind === "hunk" ? (
          <div key={i} className={cn("flex pr-4 pl-1", ROW.hunk)}>
            <span className="w-12 shrink-0" />
            <span className="whitespace-pre">{r.left?.text}</span>
          </div>
        ) : (
          <div key={i} className="grid grid-cols-2 divide-x divide-border">
            {cell(r.left, "old")}
            {cell(r.right, "new")}
          </div>
        ),
      )}
    </div>
  );
}
