import { ArrowDown, ArrowUp, ChevronRight, Clock, Coins, Gauge, Info, ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { money, seconds, tokens } from "@/lib/format";
import type { SessionInfo, TurnStats } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ToolCall, TranscriptItem } from "@/state/transcript";
import { DiffBlock, ToolCalls } from "./ToolCall";

function Stat({ icon: Icon, children, title, className }: { icon: typeof Gauge; children: React.ReactNode; title: string; className?: string }) {
  return (
    <span title={title} className={cn("flex items-center gap-[3px]", className)}>
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/** ターンの真下に出す 1 行（tok/s、入力、出力、費用、時間） */
export function TurnStatsRow({ stats, cost, error, stopReason }: { stats: TurnStats | null; cost?: string; error?: string | null; stopReason?: string | null }) {
  if (error) return <p className="text-xs text-error">{error}</p>;
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground tabular">
      {stats?.tokens_per_sec != null && (
        <Stat icon={Gauge} title={stats.estimated ? "出力トークン/秒（推定）" : "出力トークン/秒"}>
          {stats.estimated ? "~" : ""}
          {Math.round(stats.tokens_per_sec)} tok/s
        </Stat>
      )}
      {stats?.usage && (
        <>
          <Stat icon={ArrowUp} title="入力トークン">{tokens(stats.usage.input + stats.usage.cached_read + stats.usage.cached_write)}</Stat>
          <Stat icon={ArrowDown} title="出力トークン">{tokens(stats.usage.output)}</Stat>
        </>
      )}
      {cost && <Stat icon={Coins} title="このターンの費用">{cost}</Stat>}
      {stats && stats.elapsed_ms > 0 && <Stat icon={Clock} title="かかった時間">{seconds(stats.elapsed_ms)}</Stat>}
      {stopReason === "cancelled" && <span>停止しました</span>}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        考えた内容
      </button>
      {open && <p className="mt-1 border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</p>}
    </div>
  );
}

export function Transcript({ items, info, streaming }: { items: TranscriptItem[]; info: SessionInfo | null; streaming: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length, items[items.length - 1]]);

  // 連続するツール呼び出しは 1 つの枠にまとめる
  const blocks: (TranscriptItem | { kind: "tools"; tools: ToolCall[] })[] = [];
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (it.kind === "tool") {
      if (last && last.kind === "tools") last.tools.push(it);
      else blocks.push({ kind: "tools", tools: [it] });
    } else blocks.push(it);
  }

  return (
    <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-5 pt-4 pb-2">
      {items.length === 0 && <p className="m-auto text-xs text-muted-foreground">まだやり取りはありません</p>}
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "user":
            return (
              <div key={i} className="max-w-[78%] self-end rounded-[10px] bg-muted px-3 py-1.5 leading-relaxed whitespace-pre-wrap select-text">
                {b.text}
              </div>
            );
          case "agent":
            return (
              <p key={i} className="m-0 leading-[1.7] whitespace-pre-wrap select-text">
                {b.text}
                {streaming && i === blocks.length - 1 && (
                  <span aria-hidden className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-[1px] bg-foreground" />
                )}
              </p>
            );
          case "thought":
            return <Thought key={i} text={b.text} />;
          case "tools":
            return (
              <div key={i} className="flex flex-col gap-3">
                <ToolCalls tools={b.tools} />
                {b.tools.flatMap((t) => t.diffs.map((d, k) => <DiffBlock key={`${t.id}-${k}`} d={d} />))}
              </div>
            );
          case "plan":
            return (
              <div key={i} className="rounded-[10px] border bg-card px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <ListChecks className="size-3.5" aria-hidden />
                  計画
                </div>
                {b.entries.map((e, k) => (
                  <div key={k} className={cn("text-xs leading-6", e.status === "completed" && "text-muted-foreground line-through")}>
                    {e.content}
                  </div>
                ))}
              </div>
            );
          case "stats":
            return (
              <div key={i} className="flex flex-col gap-3">
                <TurnStatsRow stats={b.stats} error={b.error} stopReason={b.stopReason} cost={undefined} />
                {i < blocks.length - 1 && <div className="h-px bg-border" />}
              </div>
            );
          case "notice":
            return (
              <p key={i} className="m-0 flex gap-2 text-xs whitespace-pre-wrap text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {b.text}
              </p>
            );
        }
      })}
      {streaming && info?.live && (
        <TurnStatsRow
          stats={{
            usage: null,
            elapsed_ms: info.live.elapsed_ms,
            ttft_ms: info.live.ttft_ms,
            tokens_per_sec: info.live.est_tokens_per_sec,
            estimated: true,
          }}
        />
      )}
      <div ref={end} />
      {info?.cost && <span className="sr-only">セッションの費用 {money(info.cost.amount, info.cost.currency)}</span>}
    </div>
  );
}
