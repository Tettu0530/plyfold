import { Bell } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT, type MessageKey } from "@/i18n";
import { age } from "@/lib/format";
import type { SessionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { StatusIcon } from "./icons";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "./liquid/stage";

interface Item {
  id: string;
  title: string;
  status: SessionStatus;
  reason: string;
  color: string;
  at: number;
  /** Needs attention (permission request, unresponsive agent, error) */
  urgent: boolean;
}

// Reasons are stored as dictionary keys and resolved in the current language at render time
const URGENT: Partial<Record<SessionStatus, { reasonKey: MessageKey; color: string }>> = {
  awaiting_permission: { reasonKey: "notifications.awaitingPermission", color: "text-permission" },
  stalled: { reasonKey: "notifications.stalled", color: "text-stalled" },
  error: { reasonKey: "notifications.stoppedWithError", color: "text-error" },
};

/** Header bell: sessions that need attention and turns that finished while you weren't looking */
export function Notifications() {
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const unread = useStore((s) => s.unread);
  const openInPane = useStore((s) => s.openInPane);
  const [open, setOpen] = useState(false);
  // The notification panel expands out of the bell and shrinks back into it on close
  const menu = useLiquidMenu("menu:notifications", "notifications");
  const raised = useLiquidActiveAnchors().has("notifications");
  const toggle = (o: boolean) => {
    menu.onOpenChange(o);
    setOpen(o);
  };

  // When the app regains focus, mark notifications for sessions shown in panes as read
  useEffect(() => {
    const onFocus = () => {
      const s = useStore.getState();
      const shown = s.panes.slice(0, s.paneCount).filter((id): id is string => !!id && !!s.unread[id]);
      if (shown.length === 0) return;
      const next = { ...s.unread };
      for (const id of shown) delete next[id];
      useStore.setState({ unread: next });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const items: Item[] = [];
  for (const v of Object.values(sessions)) {
    const u = URGENT[v.record.status];
    if (u) items.push({ id: v.record.id, title: v.record.title, status: v.record.status, at: v.record.updated_at, urgent: true, reason: t(u.reasonKey), color: u.color });
    else if (unread[v.record.id]) {
      const r = unread[v.record.id];
      items.push({
        id: v.record.id,
        title: v.record.title,
        status: v.record.status,
        at: r.at,
        urgent: false,
        reason: r.error ? t("notifications.turnEndedWithError") : t("notifications.turnEnded"),
        color: r.error ? "text-error" : "text-muted-foreground",
      });
    }
  }
  items.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.at - a.at);
  const urgent = items.filter((i) => i.urgent).length;
  const label = urgent ? t("notifications.urgentLabel", { count: urgent }) : items.length ? t("notifications.newLabel", { count: items.length }) : t("notifications.title");

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button
          ref={liquidAnchor("notifications")}
          type="button"
          aria-label={label}
          className={cn("relative flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent", raised && "z-[57]")}
        >
          <Bell className="size-4" aria-hidden />
          {items.length > 0 && (
            <span aria-hidden className={cn("absolute top-1 right-1 size-[7px] rounded-full border-2 border-background", urgent ? "bg-permission" : "bg-foreground")} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={menu.ref as React.Ref<HTMLDivElement>}
        style={menu.style}
        align="end"
        sideOffset={6}
        className={cn("z-[58] flex w-80 flex-col gap-0.5 p-1.5", menu.moving && "opacity-0")}
      >
        <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{t("notifications.title")}</div>
        {items.length === 0 && <p className="px-2 pb-2 text-xs text-muted-foreground">{t("notifications.empty")}</p>}
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => {
              toggle(false);
              void openInPane(i.id);
            }}
            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
          >
            <StatusIcon status={i.status} className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex min-w-0 grow flex-col gap-0.5">
              <span className="truncate">{i.title}</span>
              <span className={cn("text-xs", i.color)}>{i.reason}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">{age(i.at)}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
