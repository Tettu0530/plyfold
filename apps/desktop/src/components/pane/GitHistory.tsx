import { GitBranch, GitCommitHorizontal, Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import type { GitCheckout, GitHistory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";

const BUTTON = "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-input px-2.5 text-xs hover:bg-accent disabled:opacity-40";
const branchKey = (b: GitHistory["branches"][number]) => `${b.remote ? "remote" : "local"}:${b.name}`;

export function GitHistoryView({
  id,
  workspace,
  sessionBranch,
  busy,
  hasRemote,
  onChanged,
}: {
  id: string;
  workspace: string | null;
  sessionBranch: string | null;
  busy: boolean;
  hasRemote: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const version = useStore((s) => s.diffVersion);
  const [history, setHistory] = useState<GitHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runVersion, setRunVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string>();
  const [selectedCommit, setSelectedCommit] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    let live = true;
    const load = () =>
      api.gitHistory(id).then(
        (next) => {
          if (!live) return;
          setHistory(next);
          setLoadError(null);
        },
        (cause: unknown) => {
          if (live) setLoadError(String(cause));
        },
      );
    void load();
    const onFocus = () => setRunVersion((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [id, version, runVersion, busy]);

  const refs = useMemo(() => {
    const byCommit = new Map<string, string[]>();
    for (const branch of history?.branches ?? []) {
      const labels = byCommit.get(branch.sha);
      if (labels) labels.push(branch.name);
      else byCommit.set(branch.sha, [branch.name]);
    }
    return byCommit;
  }, [history]);

  const run = async (task: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      await task();
      onChanged();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setPending(false);
    }
  };
  const checkout = (target: GitCheckout) =>
    run(async () => {
      await api.gitCheckout(id, target);
      setSelectedBranch(undefined);
      setSelectedCommit(undefined);
      setCreating(false);
      setName("");
    });

  const branches = history?.branches ?? [];
  const joined = branches.find((b) => !b.remote && b.name === history?.branch);
  const branch = branches.find((b) => branchKey(b) === selectedBranch) ?? joined;
  const activeBranch = branch && !branch.remote && branch.name === history?.branch;
  const selected = history?.rows.find((row) => row.commit?.sha === selectedCommit)?.commit;
  const blocked = busy || pending;
  const head = history?.branch ?? (history?.head ? `${t("pane.gitDetached")} · ${history.head.slice(0, 7)}` : t("diff.gitNoHistory"));

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex min-w-0 grow items-center gap-1.5 text-xs">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate font-mono" title={workspace ? `${head}\n${workspace}` : head}>
              {head}
            </span>
          </span>
          <button
            type="button"
            aria-label={t("diff.gitRefreshHistory")}
            title={t("diff.gitRefreshHistory")}
            className={BUTTON}
            onClick={() => setRunVersion((n) => n + 1)}
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
          {hasRemote && (
            <button type="button" className={BUTTON} disabled={pending} onClick={() => void run(() => api.gitFetch(id))}>
              {t("pane.gitFetch")}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" title={busy ? t("diff.busyDuringTurn") : undefined}>
          {branches.length > 0 && (
            <>
              <Select value={branch ? branchKey(branch) : ""} onValueChange={setSelectedBranch} disabled={blocked}>
                <SelectTrigger aria-label={t("diff.gitChooseBranch")} size="sm" className="min-w-0 max-w-full grow font-mono text-xs">
                  <SelectValue placeholder={t("diff.gitChooseBranch")} />
                </SelectTrigger>
                <SelectContent position="popper" align="start" className="max-w-[min(30rem,90vw)]">
                  {[false, true].map((remote) => {
                    const options = branches.filter((b) => b.remote === remote);
                    return options.length > 0 ? (
                      <SelectGroup key={String(remote)}>
                        <SelectLabel>{t(remote ? "diff.gitRemoteBranches" : "diff.gitLocalBranches")}</SelectLabel>
                        {options.map((option) => (
                          <SelectItem key={branchKey(option)} value={branchKey(option)} className="font-mono text-xs" title={option.name}>
                            <span className="min-w-0 truncate">{option.name}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null;
                  })}
                </SelectContent>
              </Select>
              <button
                type="button"
                className={BUTTON}
                disabled={blocked || !branch || activeBranch}
                onClick={() => branch && void checkout({ kind: branch.remote ? "remote" : "local", name: branch.name })}
              >
                {t("diff.gitCheckout")}
              </button>
            </>
          )}
          {history && (
            <button type="button" className={BUTTON} disabled={blocked || creating} onClick={() => setCreating(true)}>
              <Plus className="size-3.5" aria-hidden />
              {t("diff.gitNewBranch")}
            </button>
          )}
        </div>
        {creating && (
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked && name.trim()) void checkout({ kind: "new_branch", name: name.trim() });
            }}
          >
            <Input
              autoFocus
              aria-label={t("diff.gitBranchName")}
              placeholder={t("diff.gitBranchName")}
              value={name}
              disabled={blocked}
              onChange={(e) => setName(e.target.value)}
              className="h-8 min-w-0 grow basis-28 font-mono text-xs"
            />
            <button type="submit" className={BUTTON} disabled={blocked || !name.trim()}>
              {t("diff.gitCreateAndCheckout")}
            </button>
            <button type="button" className={BUTTON} disabled={pending} onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </button>
          </form>
        )}
        {selected && (
          <button
            type="button"
            className={cn(BUTTON, "self-start")}
            disabled={blocked || (!history?.branch && selected.sha === history?.head)}
            onClick={() => void checkout({ kind: "commit", sha: selected.sha })}
          >
            <GitCommitHorizontal className="size-3.5" aria-hidden />
            {t("diff.gitCheckoutCommit", { hash: selected.short_sha })}
          </button>
        )}
        {busy && <p className="text-xs text-muted-foreground">{t("diff.busyDuringTurn")}</p>}
        {history && sessionBranch && history.branch !== sessionBranch && <p className="text-xs text-muted-foreground">{t("diff.branchChanged")}</p>}
        {actionError && (
          <p role="alert" className="text-xs wrap-break-word whitespace-pre-wrap text-error">
            {actionError}
          </p>
        )}
        {loadError && (
          <p role="alert" className="text-xs wrap-break-word whitespace-pre-wrap text-error">
            {loadError}
          </p>
        )}
      </div>
      <div aria-label={t("diff.gitHistory")} className="min-h-0 grow overflow-auto p-2">
        {!history && !loadError && <p className="px-2 py-1 text-xs text-muted-foreground">{t("diff.loading")}</p>}
        {history && history.rows.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">{t("diff.gitNoHistory")}</p>}
        {history?.rows.map(({ graph, commit }, i) => {
          const lane = (
            <span aria-hidden className="shrink-0 font-mono text-xs whitespace-pre text-working">
              {graph}
            </span>
          );
          if (!commit) {
            return (
              <div key={`line-${i}`} className="flex h-3 items-center px-2">
                {lane}
              </div>
            );
          }
          const labels = refs.get(commit.sha) ?? [];
          const current = commit.sha === history.head;
          const decoration = [...(current ? ["HEAD"] : []), ...labels].join(", ");
          return (
            <button
              key={commit.sha}
              type="button"
              aria-pressed={selectedCommit === commit.sha}
              title={`${commit.sha} ${commit.subject}${decoration ? ` · ${decoration}` : ""}`}
              className={cn(
                "flex h-7 w-full items-center overflow-hidden rounded-md px-2 text-left hover:bg-accent",
                selectedCommit === commit.sha && "bg-muted",
              )}
              onClick={() => setSelectedCommit((prev) => (prev === commit.sha ? undefined : commit.sha))}
            >
              {lane}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.short_sha}</span>
              {decoration && (
                <span className={cn("ml-2 max-w-[45%] min-w-0 truncate rounded-sm bg-muted px-1 font-mono text-xs", current && "text-working")}>
                  {decoration}
                </span>
              )}
              <span className="ml-2 min-w-0 grow truncate text-xs">{commit.subject}</span>
            </button>
          );
        })}
        {history?.truncated && <p className="px-2 py-1 text-xs text-muted-foreground">{t("diff.gitHistoryLimited")}</p>}
      </div>
    </div>
  );
}
