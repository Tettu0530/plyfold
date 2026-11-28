// App header button beside the browser's: opens a terminal in the folder of the session in focus. With no session in
// focus (a new session, the browser) or one that has no folder (an everyday conversation), it opens in the home folder.
// The terminal is not a part of any one pane, so it is not among the pane's tools
import { SquareTerminal } from "lucide-react";

import { useT } from "@/i18n";
import { inTauri } from "@/lib/api";
import { cn } from "@/lib/utils";
import { HOME_TERMINAL, useStore } from "@/state/store";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors } from "./liquid/stage";

const ANCHOR = "app:terminal";

/** The session whose folder the terminal opens in (the focused pane's), or the home folder */
function useTerminalTarget(): { id: string; home: boolean } {
  const id = useStore((s) => {
    const focused = s.panes[s.focusedPane];
    const record = focused ? s.sessions[focused]?.record : undefined;
    return record && (record.worktree_path || record.repo_path) ? record.id : HOME_TERMINAL;
  });
  return { id, home: id === HOME_TERMINAL };
}

export function TerminalButton() {
  const t = useT();
  const raised = useLiquidActiveAnchors().has(ANCHOR);
  const target = useTerminalTarget();
  // A terminal runs a real shell, which only the app can start
  if (!inTauri) return null;
  return (
    <button
      ref={liquidAnchor(ANCHOR)}
      type="button"
      aria-label={t("pane.openTerminal")}
      title={target.home ? t("pane.openTerminalHome") : t("pane.openTerminal")}
      onClick={() => useStore.getState().openTerminal(target.id, ANCHOR)}
      className={cn(
        "relative flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground",
        raised && "z-[57]",
      )}
    >
      <SquareTerminal className="size-4" aria-hidden />
    </button>
  );
}
