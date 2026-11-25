import { Plus, SquareTerminal, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { terminalSessionOf, useStore } from "@/state/store";
import { startDrag } from "./dnd";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";
import { SessionTerminal } from "./SessionTerminal";

const BUTTON = "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground";

export default function TerminalPane({ index, id }: { index: number; id: string }) {
  const t = useT();
  const label = t("pane.terminal");
  const session = terminalSessionOf(id);
  const title = useStore((s) => s.sessions[session]?.record.title);
  const { focusPane, closePane } = useStore.getState();
  const [tabs, setTabs] = useState([1]);
  const [active, setActive] = useState(1);
  const nextTab = useRef(2);
  const prefix = useId();
  const tabId = (tab: number) => `${prefix}-tab-${tab}`;
  const panelId = (tab: number) => `${prefix}-panel-${tab}`;
  const addTab = () => {
    const tab = nextTab.current++;
    setTabs([...tabs, tab]);
    setActive(tab);
  };
  const closeTab = (tab: number) => {
    if (tabs.length === 1) {
      closePane(index);
      return;
    }
    const remaining = tabs.filter((value) => value !== tab);
    const selected = tab === active ? remaining[Math.min(tabs.indexOf(tab), remaining.length - 1)] : active;
    setTabs(remaining);
    setActive(selected);
    document.getElementById(tabId(selected))?.focus();
  };

  return (
    <section aria-label={label} onMouseDown={() => focusPane(index)} className="flex min-h-0 min-w-0 grow flex-col">
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(event) => startDrag(event, () => ({ kind: "pane", slot: index, title: title ? `${label}: ${title}` : label }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b pr-1.5 pl-3"
        >
          <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 grow truncate font-medium">{label}</span>
          {title && <span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>}
          <button type="button" title={t("pane.closePane")} aria-label={t("pane.closePane")} onClick={() => closePane(index)} className={BUTTON}>
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </PaneMenu>
      <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
        <div role="tablist" aria-label={label} className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((tab, position) => (
            <div key={tab} className={cn("flex shrink-0 items-center rounded-md", active === tab && "bg-accent")}>
              <button
                id={tabId(tab)}
                type="button"
                role="tab"
                aria-selected={active === tab}
                aria-controls={panelId(tab)}
                tabIndex={active === tab ? 0 : -1}
                onClick={() => setActive(tab)}
                onKeyDown={(event) => {
                  const targets: Record<string, number> = {
                    ArrowLeft: (position + tabs.length - 1) % tabs.length,
                    ArrowRight: (position + 1) % tabs.length,
                    Home: 0,
                    End: tabs.length - 1,
                  };
                  const target = targets[event.key];
                  if (target === undefined) return;
                  event.preventDefault();
                  setActive(tabs[target]);
                  document.getElementById(tabId(tabs[target]))?.focus();
                }}
                className={cn("h-7 px-2 text-xs", active !== tab && "text-muted-foreground hover:text-foreground")}
              >
                {t("pane.terminalTab", { n: tab })}
              </button>
              <button
                type="button"
                aria-label={t("pane.closeTerminalTab", { n: tab })}
                title={t("pane.closeTerminalTab", { n: tab })}
                onClick={() => closeTab(tab)}
                className={BUTTON}
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <button type="button" title={t("pane.newTerminalTab")} aria-label={t("pane.newTerminalTab")} onClick={addTab} className={BUTTON}>
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="relative min-h-0 min-w-0 grow bg-black">
        {tabs.map((tab) => (
          <div key={tab} id={panelId(tab)} role="tabpanel" aria-labelledby={tabId(tab)} hidden={tab !== active} className="absolute inset-0">
            <SessionTerminal session={session} />
          </div>
        ))}
      </div>
    </section>
  );
}
