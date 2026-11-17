// App header button next to the notifications: open a page in a preview pane. Lists the local URLs the agents printed
// (dev servers and the like) in the sessions shown in panes, the focused pane first, and takes any URL
import { Globe } from "lucide-react";
import { useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { previewUrls } from "@/state/paneData";
import { useStore, visibleSessions } from "@/state/store";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "./liquid/stage";
import { CloseMenu, PreviewMenu } from "./pane/PaneTools";

const ANCHOR = "app:browser";

export function BrowserButton() {
  const t = useT();
  const menu = useLiquidMenu(`menu:${ANCHOR}`, ANCHOR);
  const raised = useLiquidActiveAnchors().has(ANCHOR);
  const [open, setOpen] = useState(false);
  const change = (o: boolean) => {
    menu.onOpenChange(o);
    setOpen(o);
  };
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const layout = useStore((s) => s.layout);
  const focused = useStore((s) => s.panes[s.focusedPane]);
  const urls = useMemo(() => {
    const ids = visibleSessions({ panes, layout }).filter((id): id is string => !!id && !!sessions[id]);
    ids.sort((a, b) => Number(b === focused) - Number(a === focused));
    return [...new Set(ids.flatMap((id) => previewUrls(sessions[id].transcript.items)))];
  }, [sessions, panes, layout, focused]);

  return (
    <CloseMenu.Provider value={() => change(false)}>
      <Popover open={open} onOpenChange={change}>
        <PopoverTrigger asChild>
          <button
            ref={liquidAnchor(ANCHOR)}
            type="button"
            aria-label={t("pane.preview")}
            title={t("pane.preview")}
            className={cn("relative flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent", raised && "z-[57]")}
          >
            <Globe className="size-4" aria-hidden />
            {/* A dot when an agent has printed a local URL */}
            {urls.length > 0 && <span aria-hidden className="absolute top-1 right-1 size-[7px] rounded-full border-2 border-background bg-foreground" />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={menu.ref as React.Ref<HTMLDivElement>}
          style={menu.style}
          side="bottom"
          align="end"
          sideOffset={6}
          className={cn("z-[58] flex w-96 flex-col gap-0.5 p-1.5", menu.moving && "opacity-0")}
        >
          <div className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">{t("pane.preview")}</div>
          <PreviewMenu urls={urls} anchor={ANCHOR} />
        </PopoverContent>
      </Popover>
    </CloseMenu.Provider>
  );
}
