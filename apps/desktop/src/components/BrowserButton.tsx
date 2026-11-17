// App header button next to the notifications: opens an empty browser pane right away. The empty pane lists the local
// URLs the agents printed (dev servers and the like) in the sessions shown in panes, the focused pane first
import { Globe } from "lucide-react";
import { useMemo } from "react";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { previewUrls } from "@/state/paneData";
import { useStore, visibleSessions } from "@/state/store";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors } from "./liquid/stage";

const ANCHOR = "app:browser";

/** Local URLs printed in the sessions shown in panes, the focused pane's first */
export function useFoundUrls(): string[] {
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const layout = useStore((s) => s.layout);
  const focused = useStore((s) => s.panes[s.focusedPane]);
  return useMemo(() => {
    const ids = visibleSessions({ panes, layout }).filter((id): id is string => !!id && !!sessions[id]);
    ids.sort((a, b) => Number(b === focused) - Number(a === focused));
    return [...new Set(ids.flatMap((id) => previewUrls(sessions[id].transcript.items)))];
  }, [sessions, panes, layout, focused]);
}

export function BrowserButton() {
  const t = useT();
  const raised = useLiquidActiveAnchors().has(ANCHOR);
  const found = useFoundUrls().length > 0;
  return (
    <button
      ref={liquidAnchor(ANCHOR)}
      type="button"
      aria-label={t("pane.previewNew")}
      title={t("pane.previewNew")}
      onClick={() => useStore.getState().openPreview("", ANCHOR)}
      className={cn("relative flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground", raised && "z-[57]")}
    >
      <Globe className="size-4" aria-hidden />
      {/* A dot when an agent has printed a local URL (listed in the new pane) */}
      {found && <span aria-hidden className="absolute top-1 right-1 size-[7px] rounded-full border-2 border-background bg-foreground" />}
    </button>
  );
}
