// App header button beside the browser's: opens a terminal in the folder of the session in focus (or, when the focus is
// not on a session, the first one shown). The terminal is not a part of any one pane, so it is not among the pane's tools
import { SquareTerminal } from "lucide-react";
import { useMemo } from "react";

import { useT } from "@/i18n";
import { inTauri } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStore, visibleSessions } from "@/state/store";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors } from "./liquid/stage";

const ANCHOR = "app:terminal";

/** The session a terminal would open for: the focused pane's, else the first shown */
function useTerminalSession(): string | null {
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const layout = useStore((s) => s.layout);
  const focused = useStore((s) => s.panes[s.focusedPane]);
  return useMemo(() => {
    const ids = visibleSessions({ panes, layout }).filter((id): id is string => !!id && !!sessions[id]);
    return (focused && ids.includes(focused) ? focused : ids[0]) ?? null;
  }, [sessions, panes, layout, focused]);
}

export function TerminalButton() {
  const t = useT();
  const raised = useLiquidActiveAnchors().has(ANCHOR);
  const session = useTerminalSession();
  // A terminal runs a real shell, which only the app can start
  if (!inTauri) return null;
  return (
    <button
      ref={liquidAnchor(ANCHOR)}
      type="button"
      disabled={!session}
      aria-label={t("pane.openTerminal")}
      title={session ? t("pane.openTerminal") : t("pane.openTerminalNone")}
      onClick={() => session && useStore.getState().openTerminal(session, ANCHOR)}
      className={cn(
        "relative flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        raised && "z-[57]",
      )}
    >
      <SquareTerminal className="size-4" aria-hidden />
    </button>
  );
}
