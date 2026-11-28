// Verification commands in a comparison: pick or type commands, run them in every candidate's worktree, and show each
// one's status, duration and output next to the usual numbers (a pass is evidence, not a verdict)
import { Ban, Check, CircleAlert, Clock, ListChecks, Play, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { notRun, parseCommands, runCheck, type CheckRun } from "@/lib/checks";
import { seconds } from "@/lib/format";
import type { VerifyResult, RepoSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { SessionView } from "@/state/store";
import { Spinner } from "../icons";

export interface CompareChecks {
  commands: string[];
  selected: Set<string>;
  results: Record<string, VerifyResult[]>;
  /** The command now running in a session */
  current: Record<string, string>;
  running: boolean;
  toggle: (command: string) => void;
  add: (text: string) => void;
  remove: (command: string) => void;
  run: () => void;
  stop: () => void;
}

/** The repository's verification commands, which of them are picked, and the results of running them per session */
export function useCompareChecks(repo: string | null, members: SessionView[]): CompareChecks {
  const [settings, setSettings] = useState<RepoSettings | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, VerifyResult[]>>({});
  const [current, setCurrent] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const active = useRef(new Map<string, CheckRun>());
  const interrupted = useRef(false);
  const membersRef = useRef(members);
  membersRef.current = members;

  useEffect(() => {
    if (!inTauri || !repo) return;
    let alive = true;
    void api.listRepos().then(
      (all) => {
        const mine = all.find((r) => r.path === repo)?.settings;
        if (!alive) return;
        setSettings(mine ?? null);
        setSelected(new Set(mine?.checks ?? []));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [repo]);

  const commands = settings?.checks ?? [];
  const save = useCallback(
    (checks: string[]) => {
      if (!repo) return;
      const next: RepoSettings = { ...(settings ?? { name: "", setup: "", copy: [], allow: [], review: "", reviewer: "", checks: [] }), checks };
      setSettings(next);
      void api.saveRepoSettings(repo, next).catch(() => {});
    },
    [repo, settings],
  );

  const toggle = (command: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(command)) next.add(command);
      return next;
    });
  const add = (text: string) => {
    const added = parseCommands(text).filter((c) => !commands.includes(c));
    if (added.length === 0) return;
    save([...commands, ...added]);
    setSelected((s) => new Set([...s, ...added]));
  };
  const remove = (command: string) => {
    save(commands.filter((c) => c !== command));
    setSelected((s) => {
      const next = new Set(s);
      next.delete(command);
      return next;
    });
  };

  const run = () => {
    const picked = commands.filter((c) => selected.has(c));
    const sessions = membersRef.current.map((m) => m.record.id);
    if (picked.length === 0 || sessions.length === 0 || running) return;
    interrupted.current = false;
    setRunning(true);
    setResults({});
    setCurrent({});
    // Every candidate runs its commands one after another in its own worktree; candidates run side by side
    void Promise.all(
      sessions.map(async (id) => {
        for (const command of picked) {
          let result: VerifyResult;
          if (interrupted.current) {
            result = notRun(command);
          } else {
            setCurrent((c) => ({ ...c, [id]: command }));
            const job = runCheck(id, command);
            active.current.set(id, job);
            result = await job.done;
            active.current.delete(id);
          }
          setResults((r) => ({ ...r, [id]: [...(r[id] ?? []), result] }));
        }
        setCurrent((c) => {
          const next = { ...c };
          delete next[id];
          return next;
        });
      }),
    ).finally(() => setRunning(false));
  };
  const stop = () => {
    interrupted.current = true;
    for (const job of active.current.values()) job.stop();
  };
  // Leaving the comparison stops what is running
  useEffect(
    () => () => {
      interrupted.current = true;
      for (const job of active.current.values()) job.stop();
    },
    [],
  );

  return { commands, selected, results, current, running, toggle, add, remove, run, stop };
}

export function ChecksBar({ checks, busy }: { checks: CompareChecks; busy: boolean }) {
  const t = useT();
  const [text, setText] = useState("");
  const picked = checks.commands.filter((c) => checks.selected.has(c)).length;
  const submit = () => {
    checks.add(text);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium">{t("compare.checks")}</span>
        <span className="grow" />
        {checks.running ? (
          <button type="button" onClick={checks.stop} className="flex h-7 items-center gap-1.5 rounded-lg border border-input px-2 text-xs hover:bg-accent">
            <Square className="size-3.5" aria-hidden />
            {t("compare.checksStop")}
          </button>
        ) : (
          <button
            type="button"
            onClick={checks.run}
            disabled={busy || picked === 0}
            title={busy ? t("compare.checksBusy") : undefined}
            className="flex h-7 items-center gap-1.5 rounded-lg border border-input px-2 text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <Play className="size-3.5" aria-hidden />
            {t("compare.checksRun")}
          </button>
        )}
      </div>
      {checks.commands.length === 0 ? (
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t("compare.checksNone")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {checks.commands.map((c) => (
            <li key={c} className="flex min-w-0 items-center gap-2 text-xs">
              <label className="flex min-w-0 grow cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={checks.selected.has(c)}
                  disabled={checks.running}
                  onChange={() => checks.toggle(c)}
                  className="size-3.5 shrink-0"
                />
                <code className="min-w-0 truncate font-mono">{c}</code>
              </label>
              <button
                type="button"
                aria-label={t("compare.checksRemove")}
                title={t("compare.checksRemove")}
                disabled={checks.running}
                onClick={() => checks.remove(c)}
                className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("compare.checksPlaceholder")}
          aria-label={t("compare.checks")}
          spellCheck={false}
          className="h-7 min-w-0 grow font-mono text-xs"
        />
        <button
          type="submit"
          disabled={text.trim() === ""}
          className="h-7 shrink-0 rounded-lg border border-input px-2 text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          {t("compare.checksAdd")}
        </button>
      </form>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t("compare.checksHint")}</p>
    </div>
  );
}

const LABEL = {
  passed: "compare.checkPassed",
  failed: "compare.checkFailed",
  timeout: "compare.checkTimeout",
  interrupted: "compare.checkInterrupted",
  not_run: "compare.checkNotRun",
} as const;

function StatusMark({ status, className }: { status: VerifyResult["status"]; className?: string }) {
  if (status === "passed") return <Check className={cn("text-working", className)} aria-hidden />;
  if (status === "failed") return <CircleAlert className={cn("text-error", className)} aria-hidden />;
  if (status === "timeout") return <Clock className={cn("text-error", className)} aria-hidden />;
  return <Ban className={cn("text-muted-foreground", className)} aria-hidden />;
}

/** A run's results: one line per command (status, duration), with its output behind it */
export function CheckResults({ results, current }: { results: VerifyResult[]; current?: string }) {
  const t = useT();
  if (results.length === 0 && !current) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs" aria-label={t("compare.checks")}>
      {results.map((r) => (
        <li key={r.command}>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent [&::-webkit-details-marker]:hidden">
              <StatusMark status={r.status} className="size-3.5 shrink-0" />
              <code className="min-w-0 grow truncate font-mono">{r.command}</code>
              <span
                className={cn(
                  "shrink-0",
                  r.status === "passed" ? "text-working" : r.status === "failed" || r.status === "timeout" ? "text-error" : "text-muted-foreground",
                )}
              >
                {t(LABEL[r.status])}
              </span>
              {r.status !== "not_run" && <span className="shrink-0 font-mono tabular text-muted-foreground">{seconds(r.duration_ms)}</span>}
            </summary>
            {r.status !== "not_run" && (
              <div className="flex flex-col gap-1 px-1 pt-1 pb-1.5">
                <span className="text-muted-foreground">
                  {r.exit_code !== null && t("compare.checkExit", { code: r.exit_code })} {r.truncated && t("compare.checkTruncated")}
                </span>
                <pre className="m-0 max-h-60 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
                  {r.output === "" ? t("compare.checkNoOutput") : r.output}
                </pre>
              </div>
            )}
          </details>
        </li>
      ))}
      {current && (
        <li className="flex items-center gap-2 px-1 py-0.5 text-muted-foreground">
          <Spinner className="size-3.5 shrink-0" />
          <code className="min-w-0 grow truncate font-mono">{current}</code>
          <span className="shrink-0">{t("compare.checkRunning")}</span>
        </li>
      )}
    </ul>
  );
}
