// Verification commands for a comparison: the same shell commands run in each candidate's worktree, and how each went.
// A pass is evidence for the person choosing, not a verdict on the quality of the change
import { api } from "@/lib/api";
import type { VerifyResult } from "@/lib/types";

/** What is kept of a command's output: the end of it, where failures usually are */
export const KEEP_OUTPUT = 32 * 1024;
/** A command that has not finished by now is stopped */
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** The last `limit` characters of `text`, and whether anything was cut */
export function tail(text: string, limit = KEEP_OUTPUT): { text: string; cut: boolean } {
  return text.length <= limit ? { text, cut: false } : { text: text.slice(text.length - limit), cut: true };
}

/** A result for a command that never ran (its run was interrupted, or the session had nothing to run it in) */
export const notRun = (command: string): VerifyResult => ({ command, status: "not_run", exit_code: null, duration_ms: 0, output: "", truncated: false });

/** Whether every command that ran passed (nothing run is not a pass) */
export function allPassed(results: VerifyResult[]): boolean {
  return results.length > 0 && results.every((r) => r.status === "passed");
}

/** Commands as typed: one per line, blanks and duplicates dropped */
export function parseCommands(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !seen.has(l) && !!seen.add(l));
}

export interface CheckRun {
  /** Settles with the outcome; never rejects */
  done: Promise<VerifyResult>;
  /** Stop the command (its outcome is then "interrupted") */
  stop: () => void;
}

/** Run one command in the session's folder through the same runner as `!command` in the composer */
export function runCheck(session: string, command: string, timeoutMs = CHECK_TIMEOUT_MS): CheckRun {
  const started = performance.now();
  let output = "";
  let id: number | null = null;
  let stopped: "interrupted" | "timeout" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: "interrupted" | "timeout" = "interrupted") => {
    if (stopped) return;
    stopped = why;
    if (id !== null) void api.stopShell(id).catch(() => {});
  };
  const done = new Promise<VerifyResult>((resolve) => {
    const finish = (status: VerifyResult["status"], code: number | null, runnerCut: boolean) => {
      clearTimeout(timer);
      const kept = tail(output);
      resolve({ command, status, exit_code: code, duration_ms: Math.round(performance.now() - started), output: kept.text, truncated: kept.cut || runnerCut });
    };
    api
      .startShell(session, command, (e) => {
        if (e.kind === "output") output += e.data;
        else finish(stopped ?? (e.code === 0 ? "passed" : "failed"), e.code, e.truncated);
      })
      .then(
        (run) => {
          id = run;
          timer = setTimeout(() => stop("timeout"), timeoutMs);
          // Stopped before the runner had answered
          if (stopped) void api.stopShell(run).catch(() => {});
        },
        (e) => {
          output = String(e);
          finish(stopped ?? "failed", null, false);
        },
      );
  });
  return { done, stop: () => stop("interrupted") };
}
