// A `!command` run from the composer: the command and its output, kept in the conversation view only
import { SendHorizontal, Square, Terminal } from "lucide-react";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import type { ShellRun } from "@/state/transcript";
import { Spinner } from "../icons";

export function ShellBlock({ item, sessionId }: { item: ShellRun; sessionId?: string }) {
  const t = useT();
  const running = item.status === "running";
  const failed = !running && item.code !== 0;
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card text-xs">
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2">
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <code className="min-w-0 grow truncate font-mono" title={item.command}>
          {item.command}
        </code>
        {running ? (
          <>
            <Spinner className="size-3.5 text-muted-foreground" />
            <button
              type="button"
              aria-label={t("shell.stop")}
              title={t("shell.stop")}
              onClick={() => useStore.getState().stopShell(item.run)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Square className="size-3 fill-current" aria-hidden />
            </button>
          </>
        ) : (
          <>
            <span className={cn("shrink-0 font-mono", failed ? "text-error" : "text-muted-foreground")}>
              {item.code === null ? t("shell.stopped") : t("shell.exit", { code: item.code })}
            </span>
            {sessionId && (
              <button
                type="button"
                aria-label={t("shell.sendOn")}
                title={t("shell.sendOn")}
                onClick={() => useStore.getState().sendShellOn(sessionId, item.run)}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <SendHorizontal className="size-3.5" aria-hidden />
              </button>
            )}
          </>
        )}
      </div>
      {item.output && (
        <pre className="m-0 max-h-72 overflow-auto px-3 pb-2 font-mono text-xs leading-relaxed whitespace-pre-wrap select-text">{item.output}</pre>
      )}
      {item.truncated && <p className="m-0 px-3 pb-2 text-muted-foreground">{t("shell.truncated")}</p>}
      {!item.output && !running && <div className="h-1" />}
    </div>
  );
}
