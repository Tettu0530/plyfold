// The Git button in a session pane's header: the branch, how it stands against the branch it will be merged into and
// against its upstream, the commits on it, and the pull request. Fetch / push / pull and creating a PR from here.
// The info refreshes when the pane opens, when a turn ends and after each action; opening the menu also fetches from the
// remote if that hasn't happened for a while
import { ArrowDown, ArrowUp, Check, CircleDot, ExternalLink, GitBranch, GitMerge, GitPullRequest, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { age } from "@/lib/format";
import type { GitInfo, PullRequest } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";

/** Fetch again on open when the last fetch is older than this */
const STALE_FETCH_S = 5 * 60;

/** Commits not on the remote yet: against the upstream once pushed, else everything on top of the base */
export const unpushed = (g: GitInfo) => (g.upstream ? g.ahead : g.ahead_base);

export function useGitInfo(id: string, busy: boolean) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diffVersion = useStore((s) => s.diffVersion);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      const g = await api.gitInfo(id);
      if (!alive.current) return;
      setInfo(g);
      setError(null);
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  }, [id]);
  const refreshPr = useCallback(async () => {
    if (!inTauri) return;
    const p = await api.pullRequest(id).catch(() => null);
    if (alive.current) setPr(p);
  }, [id]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // On open, after worktree actions (commit, merge…) and when a turn ends
  useEffect(() => {
    if (!busy) void refresh();
  }, [refresh, busy, diffVersion]);
  return { info, pr, error, refresh, refreshPr, setInfo };
}

export type GitState = ReturnType<typeof useGitInfo>;

type Action = "fetch" | "push" | "pull" | "pr";

export function GitPanel({ id, git, busy, worktree, title }: { id: string; git: GitState; busy: boolean; worktree: boolean; title: string }) {
  const t = useT();
  const [running, setRunning] = useState<Action | null>(null);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const { info, pr } = git;

  const run = async (a: Action, f: () => Promise<unknown>, done?: (r: unknown) => string) => {
    setRunning(a);
    setNote(null);
    try {
      const r = await f();
      if (done) setNote({ error: false, text: done(r) });
    } catch (e) {
      setNote({ error: true, text: String(e) });
    } finally {
      setRunning(null);
      await git.refresh();
      void git.refreshPr();
    }
  };

  // Opening the menu: show what we have, then look at the remote (fetch only if it is stale) and the PR
  useEffect(() => {
    void git.refreshPr();
    const old = !info?.fetched_at || Date.now() / 1000 - info.fetched_at > STALE_FETCH_S;
    if (info?.remote_url && old) void run("fetch", () => api.gitFetch(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (git.error && !info) return <p className="m-0 px-1.5 pb-1 text-xs text-muted-foreground">{t("pane.gitNoRepo")}</p>;
  if (!info) return <p className="m-0 px-1.5 pb-1 text-xs text-muted-foreground">{t("pane.gitLoading")}</p>;

  const toPush = unpushed(info);
  const page = info.web_url && info.branch ? `${info.web_url}/tree/${info.branch.split("/").map(encodeURIComponent).join("/")}` : info.web_url;
  const btn = "flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-40";
  const spin = (a: Action, Icon: typeof RefreshCw) =>
    running === a ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Icon className="size-3.5" aria-hidden />;

  return (
    <div className="flex flex-col gap-2 px-1.5 pb-1">
      {/* Branch and where it stands */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate font-mono text-xs" title={info.branch ?? undefined}>
            {info.branch ?? t("pane.gitDetached")}
          </span>
          {page && (
            <button
              type="button"
              onClick={() => void api.openUrl(page)}
              aria-label={t("pane.gitOpenWeb")}
              title={t("pane.gitOpenWeb")}
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
        {info.base && (
          <span className="text-xs text-muted-foreground">
            {info.ahead_base > 0 ? t("pane.gitAheadBase", { base: info.base, count: info.ahead_base }) : t("pane.gitSameAsBase", { base: info.base })}
          </span>
        )}
        {info.base && info.behind_base > 0 && (
          <span className="text-xs text-muted-foreground">{t("pane.gitBehindBase", { base: info.base, count: info.behind_base })}</span>
        )}
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {!info.remote_url ? (
            t("pane.gitNoRemote")
          ) : !info.upstream ? (
            t("pane.gitNotPushed")
          ) : info.ahead === 0 && info.behind === 0 ? (
            t("pane.gitUpToDate", { upstream: info.upstream })
          ) : (
            <>
              {info.ahead > 0 && (
                <span className="flex items-center gap-0.5" title={t("pane.gitAheadTitle")}>
                  <ArrowUp className="size-3" aria-hidden />
                  <span className="font-mono tabular">{info.ahead}</span>
                </span>
              )}
              {info.behind > 0 && (
                <span className="flex items-center gap-0.5" title={t("pane.gitBehindTitle")}>
                  <ArrowDown className="size-3" aria-hidden />
                  <span className="font-mono tabular">{info.behind}</span>
                </span>
              )}
              <span className="truncate">{info.upstream}</span>
            </>
          )}
          {info.fetched_at && <span className="ml-auto shrink-0 font-mono tabular">{t("pane.gitFetchedAt", { age: age(info.fetched_at * 1000) })}</span>}
        </span>
        {info.changed > 0 && <span className="text-xs text-muted-foreground">{t("pane.gitChanged", { count: info.changed })}</span>}
      </div>

      {/* Remote actions */}
      {info.remote_url && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={btn} disabled={!!running} onClick={() => void run("fetch", () => api.gitFetch(id))}>
            {spin("fetch", RefreshCw)}
            {t("pane.gitFetch")}
          </button>
          <button
            type="button"
            className={btn}
            disabled={!!running || !info.branch || (info.upstream !== null && info.ahead === 0)}
            onClick={() =>
              void run(
                "push",
                () => api.gitPush(id),
                (u) => t("pane.gitPushed", { upstream: String(u) }),
              )
            }
          >
            {spin("push", ArrowUp)}
            {t("pane.gitPush")}
            {toPush > 0 && <span className="font-mono tabular text-muted-foreground">{toPush}</span>}
          </button>
          <button
            type="button"
            className={btn}
            disabled={!!running || busy || info.behind === 0}
            title={busy ? t("pane.gitBusy") : undefined}
            onClick={() =>
              void run(
                "pull",
                () => api.gitPull(id),
                () => t("pane.gitPulled"),
              )
            }
          >
            {spin("pull", ArrowDown)}
            {t("pane.gitPull")}
            {info.behind > 0 && <span className="font-mono tabular text-muted-foreground">{info.behind}</span>}
          </button>
          {!pr && worktree && info.ahead_base > 0 && (
            <button
              type="button"
              className={btn}
              disabled={!!running || busy || info.changed > 0}
              title={info.changed > 0 ? t("pane.gitCommitFirst") : undefined}
              onClick={() =>
                void run(
                  "pr",
                  () => api.createPr(id),
                  () => t("pane.gitPrCreated"),
                )
              }
            >
              {spin("pr", GitPullRequest)}
              {t("pane.gitCreatePr")}
            </button>
          )}
        </div>
      )}
      {note && <p className={cn("m-0 text-xs whitespace-pre-wrap", note.error ? "text-error" : "text-muted-foreground")}>{note.text}</p>}

      {/* Pull request */}
      {pr && <PrRow pr={pr} title={title} />}

      {/* Commits */}
      <div className="flex flex-col">
        <span className="pb-1 text-xs font-medium text-muted-foreground">{t("pane.gitCommits")}</span>
        {info.commits.length === 0 && (
          <span className="text-xs text-muted-foreground">{info.base ? t("pane.gitNoCommitsSinceBase", { base: info.base }) : t("pane.gitNoCommits")}</span>
        )}
        {info.commits.map((c) => (
          <div key={c.sha} className="flex h-7 items-center gap-2" title={`${c.sha} ${c.author}`}>
            {/* Commits not on the remote yet are marked (pushed ones have no mark) */}
            <span className="flex w-3.5 shrink-0 justify-center" aria-label={c.pushed ? undefined : t("pane.gitUnpushed")}>
              {!c.pushed && info.remote_url && <ArrowUp className="size-3 text-muted-foreground" aria-hidden />}
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.sha}</span>
            <span className="min-w-0 grow truncate text-sm">{c.subject}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">{age(c.time * 1000)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PrRow({ pr, title }: { pr: PullRequest; title: string }) {
  const t = useT();
  const state =
    pr.state === "MERGED"
      ? { Icon: GitMerge, label: t("pane.gitPrMerged") }
      : pr.state === "CLOSED"
        ? { Icon: X, label: t("pane.gitPrClosed") }
        : { Icon: GitPullRequest, label: pr.draft ? t("pane.gitPrDraft") : t("pane.gitPrOpen") };
  const review =
    pr.review === "APPROVED"
      ? t("pane.gitReviewApproved")
      : pr.review === "CHANGES_REQUESTED"
        ? t("pane.gitReviewChanges")
        : pr.review === "REVIEW_REQUIRED"
          ? t("pane.gitReviewRequired")
          : null;
  const { passed, failed, pending } = pr.checks;
  return (
    <button
      type="button"
      onClick={() => void api.openUrl(pr.url)}
      title={pr.title || title}
      className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-left hover:bg-accent"
    >
      <span className="flex items-center gap-1.5">
        <state.Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono text-xs">#{pr.number}</span>
        <span className="min-w-0 grow truncate text-sm">{pr.title}</span>
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </span>
      <span className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{state.label}</span>
        {review && <span>{review}</span>}
        {passed + failed + pending > 0 && (
          <span className="flex items-center gap-2" aria-label={t("pane.gitChecks", { passed, failed, pending })}>
            {passed > 0 && (
              <span className="flex items-center gap-0.5">
                <Check className="size-3 text-working" aria-hidden />
                <span className="font-mono tabular">{passed}</span>
              </span>
            )}
            {failed > 0 && (
              <span className="flex items-center gap-0.5">
                <X className="size-3 text-error" aria-hidden />
                <span className="font-mono tabular">{failed}</span>
              </span>
            )}
            {pending > 0 && (
              <span className="flex items-center gap-0.5">
                <CircleDot className="size-3 text-permission" aria-hidden />
                <span className="font-mono tabular">{pending}</span>
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}
