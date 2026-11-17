import { ChevronLeft, ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { parsePatch, toSplit, type FilePatch, type PatchLine } from "@/lib/patch";
import type { Diff, WtStatus } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT, type MessageKey } from "@/i18n";
import { useStore } from "@/state/store";
import { ProviderLogo } from "./icons";
import { Keys } from "./Keys";
import { useLiquidClip, useLiquidRevealed } from "./liquid/stage";
import { Num, ROW, Unified } from "./PatchLines";
import { Segmented } from "./Segmented";

type View = "unified" | "split";

const BADGE: Record<FilePatch["status"], { letter: string; className: string; label: MessageKey }> = {
  added: { letter: "A", className: "text-working", label: "diff.badgeAdded" },
  deleted: { letter: "D", className: "text-error", label: "diff.badgeDeleted" },
  modified: { letter: "M", className: "text-muted-foreground", label: "diff.badgeModified" },
  renamed: { letter: "R", className: "text-muted-foreground", label: "diff.badgeRenamed" },
};

/** Diff screen. Overlays the sidebar and panes, expanding out of the pane's diff count */
export function DiffView() {
  const t = useT();
  const diff = useStore((s) => s.diff);
  const view = useStore((s) => (diff ? s.sessions[diff.id] : undefined));
  const closeDiff = useStore((s) => s.closeDiff);
  const revealed = useLiquidRevealed("diff");
  const surface = useRef<HTMLDivElement>(null);
  const moving = useLiquidClip("diff", surface);
  const [data, setData] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<View>("unified");
  const id = diff?.id;
  const [wt, setWt] = useState<WtStatus | null>(null);
  const bumpDiff = useStore((s) => s.bumpDiff);

  const reload = (sid: string) =>
    Promise.all([api.sessionDiff(sid), api.worktreeStatus(sid)])
      .then(([d, st]) => {
        setData(d);
        setWt(st);
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    if (!id) return;
    setData(null);
    setWt(null);
    setError(null);
    setSel(0);
    void reload(id);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDiff();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, closeDiff]);

  const files = useMemo(() => {
    if (!data) return [];
    const parsed = parsePatch(data.patch);
    // Counts come from the engine (--numstat); lines come from the patch
    return data.files.map((f) => ({ stat: f, patch: parsed.find((p) => p.path === f.path) }));
  }, [data]);
  const total = files.reduce((a, f) => ({ add: a.add + f.stat.added, del: a.del + f.stat.removed }), { add: 0, del: 0 });

  if (!diff || !view) return null;
  const r = view.record;
  const current = files[Math.min(sel, files.length - 1)];
  const visible = revealed && !diff.closing;

  return (
    <div
      ref={surface}
      data-diff-view
      role="dialog"
      aria-label={t("diff.dialogLabel", { title: r.title })}
      aria-hidden={!visible}
      className={cn("fixed inset-x-0 top-10 bottom-0 flex flex-col bg-background transition-opacity duration-150", moving ? "pointer-events-none z-[56]" : "z-40", visible ? "opacity-100" : "pointer-events-none opacity-0")}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-3 pl-2">
        <button type="button" onClick={closeDiff} className="flex h-7 items-center gap-1 rounded-lg pr-2 pl-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronLeft className="size-4" aria-hidden />
          {t("diff.backToPane")}
          <Keys keys={["esc"]} />
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="truncate font-medium">{r.title}</span>
        <span className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          <ProviderLogo agent={r.agent} className="size-3" />
          {r.profile === r.agent ? "default" : r.profile}
        </span>
        <span className="grow" />
        {r.branch && (
          <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <GitBranch className="size-3.5" aria-hidden />
            {r.branch}
            {r.base_ref && <span>← {r.base_ref.slice(0, 7)}</span>}
          </span>
        )}
      </div>

      <div className="flex min-h-0 grow">
        <aside aria-label={t("diff.changedFilesLabel")} className="flex w-[300px] shrink-0 flex-col border-r bg-sidebar">
          <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-xs">
            <span className="font-medium text-muted-foreground">{data ? t("diff.changedFilesCount", { count: files.length }) : t("diff.loading")}</span>
            <span className="grow" />
            {data && (
              <span className="font-mono tabular">
                <span className="text-working">+{total.add}</span> <span className="text-error">−{total.del}</span>
              </span>
            )}
          </div>
          <div role="listbox" aria-label={t("diff.filesLabel")} className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto px-2 pb-2">
            {files.map((f, i) => {
              const b = BADGE[f.patch?.status ?? (f.stat.untracked ? "added" : "modified")];
              return (
                <button
                  key={f.stat.path}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  onClick={() => setSel(i)}
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
        </aside>

        <main className="flex min-w-0 grow flex-col">
          {error && <p className="p-4 text-xs whitespace-pre-wrap text-error">{t("diff.loadFailed", { error })}</p>}
          {data && files.length === 0 && <p className="p-4 text-xs text-muted-foreground">{r.base_ref ? t("diff.noChangesSince", { base: r.base_ref.slice(0, 7) }) : t("diff.noChanges")}</p>}
          {current && (
            <>
              <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
                <span className="truncate font-mono">{current.stat.path}</span>
                <span className="shrink-0 font-mono text-xs tabular">
                  <span className="text-working">+{current.stat.added}</span> <span className="text-error">−{current.stat.removed}</span>
                </span>
                <span className="grow" />
                <Segmented<View>
                  label={t("diff.viewLabel")}
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "unified", label: t("diff.viewUnified") },
                    { value: "split", label: t("diff.viewSplit") },
                  ]}
                />
              </div>
              <div className="min-h-0 grow overflow-auto py-1 font-mono text-xs leading-5">
                {current.stat.binary || current.patch?.binary ? (
                  <p className="px-4 py-2 text-muted-foreground">{t("diff.binaryFile")}</p>
                ) : !current.patch ? (
                  <p className="px-4 py-2 text-muted-foreground">{t("diff.noPatchLines")}</p>
                ) : mode === "unified" ? (
                  <Unified lines={current.patch.lines} />
                ) : (
                  <Split lines={current.patch.lines} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
      {wt && (
        <Actions
          key={id}
          id={diff.id}
          title={r.title}
          status={wt}
          busy={view.record.status === "working" || view.record.status === "awaiting_permission" || view.record.status === "starting" || view.record.status === "stalled"}
          onDone={() => {
            bumpDiff();
            return reload(diff.id);
          }}
        />
      )}
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
          <Input aria-label={t("diff.commitMessageLabel")} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus className="h-8 grow text-sm" />
          <button type="button" onClick={() => setComposing(false)} className="h-8 rounded-lg px-3 text-muted-foreground hover:bg-accent hover:text-foreground">
            {t("common.cancel")}
          </button>
          <button type="submit" disabled={running || !message.trim()} className="h-8 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
            {t("diff.commit")}
          </button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void openEditor()} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
            <ExternalLink className="size-3.5" aria-hidden />
            {t("diff.openInEditor")}
          </button>
          {!status.dirty &&
            status.commits > 0 &&
            (confirmPr ? (
              <button type="button" disabled={running || busy} onClick={() => void pr()} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent disabled:opacity-40">
                <GitPullRequest className="size-3.5" aria-hidden />
                {t("diff.pushAndCreatePr")}
              </button>
            ) : (
              <button type="button" disabled={running || busy} onClick={() => setConfirmPr(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent disabled:opacity-40">
                <GitPullRequest className="size-3.5" aria-hidden />
                {t("diff.createPr")}
              </button>
            ))}
          <span className="pl-2 text-xs text-muted-foreground">{busy ? t("diff.busyDuringTurn") : summary}</span>
          <span className="grow" />
          {!nothing &&
            (confirmDiscard ? (
              <button type="button" disabled={running || busy} onClick={() => void discard()} className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-error hover:bg-error/10 disabled:opacity-40">
                <Trash2 className="size-3.5" aria-hidden />
                {t("diff.discardWithCommits")}
              </button>
            ) : (
              <button type="button" disabled={running || busy} onClick={() => setConfirmDiscard(true)} className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-error hover:bg-error/10 disabled:opacity-40">
                <Trash2 className="size-3.5" aria-hidden />
                {t("diff.discard")}
              </button>
            ))}
          {status.dirty ? (
            <button type="button" disabled={running || busy} onClick={() => setComposing(true)} className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
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
