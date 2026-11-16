import { Bell } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { age } from "@/lib/format";
import type { SessionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { StatusIcon } from "./icons";

interface Item {
  id: string;
  title: string;
  status: SessionStatus;
  reason: string;
  color: string;
  at: number;
  /** 手を貸す必要がある（権限確認・無応答・エラー） */
  urgent: boolean;
}

const URGENT: Partial<Record<SessionStatus, { reason: string; color: string }>> = {
  awaiting_permission: { reason: "権限確認待ち", color: "text-permission" },
  stalled: { reason: "無応答", color: "text-stalled" },
  error: { reason: "エラーで止まりました", color: "text-error" },
};

/** 見出しのベル: 手を貸す必要があるセッションと、見ていないあいだに終わったターン */
export function Notifications() {
  const sessions = useStore((s) => s.sessions);
  const unread = useStore((s) => s.unread);
  const openInPane = useStore((s) => s.openInPane);
  const [open, setOpen] = useState(false);

  // アプリに戻ってきたら、ペインに出ているセッションの知らせは読んだことにする
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
    if (u) items.push({ id: v.record.id, title: v.record.title, status: v.record.status, at: v.record.updated_at, urgent: true, ...u });
    else if (unread[v.record.id]) {
      const r = unread[v.record.id];
      items.push({
        id: v.record.id,
        title: v.record.title,
        status: v.record.status,
        at: r.at,
        urgent: false,
        reason: r.error ? "ターンがエラーで終わりました" : "ターンが終わりました",
        color: r.error ? "text-error" : "text-muted-foreground",
      });
    }
  }
  items.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.at - a.at);
  const urgent = items.filter((i) => i.urgent).length;
  const label = urgent ? `手を貸す必要があるセッション ${urgent} 件` : items.length ? `新しい知らせ ${items.length} 件` : "知らせ";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="relative flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
        >
          <Bell className="size-4" aria-hidden />
          {items.length > 0 && (
            <span aria-hidden className={cn("absolute top-1 right-1 size-[7px] rounded-full border-2 border-background", urgent ? "bg-permission" : "bg-foreground")} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-0.5 p-1.5">
        <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">知らせ</div>
        {items.length === 0 && <p className="px-2 pb-2 text-xs text-muted-foreground">新しい知らせはありません</p>}
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => {
              setOpen(false);
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
