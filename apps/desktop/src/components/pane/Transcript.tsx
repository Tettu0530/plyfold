import { ArrowDown, ArrowUp, ChevronRight, Clock, Coins, Gauge, Info, ListChecks } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { useT, contentLang } from "@/i18n";
import { money, seconds, tokens } from "@/lib/format";
import type { SessionInfo, TurnStats } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ToolCall, TranscriptItem } from "@/state/transcript";
import { resendable, type Attached } from "@/lib/attachments";
import { SentAttachments } from "./Attachments";
import { Markdown } from "./Markdown";
import { ActionRow, CopyButton, EditBox, UserActions, Working, workingLabel } from "./MessageActions";
import { DiffBlock, ToolCalls } from "./ToolCall";
import { snappy } from "../motion";

function Stat({ icon: Icon, children, title, className }: { icon: typeof Gauge; children: React.ReactNode; title: string; className?: string }) {
  return (
    <span title={title} className={cn("flex items-center gap-[3px]", className)}>
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/** One line right under a turn (tok/s, input, output, cost, time) */
/** Time the answer finished. Just the time for today, with the date for other days */
function clock(ms: number): string {
  const d = new Date(ms);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function TurnStatsRow({
  stats,
  cost,
  error,
  stopReason,
  endedAt,
}: {
  stats: TurnStats | null;
  cost?: string;
  error?: string | null;
  stopReason?: string | null;
  endedAt?: number | null;
}) {
  const t = useT();
  if (error) return <p className="text-xs text-error">{error}</p>;
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground tabular">
      {stats?.tokens_per_sec != null && (
        <Stat icon={Gauge} title={stats.estimated ? t("transcript.tokPerSecEstimated") : t("transcript.tokPerSec")}>
          {stats.estimated ? "~" : ""}
          {Math.round(stats.tokens_per_sec)} tok/s
        </Stat>
      )}
      {stats?.usage && (
        <>
          <Stat icon={ArrowUp} title={t("transcript.inputTokens")}>{tokens(stats.usage.input + stats.usage.cached_read + stats.usage.cached_write)}</Stat>
          <Stat icon={ArrowDown} title={t("transcript.outputTokens")}>{tokens(stats.usage.output)}</Stat>
        </>
      )}
      {cost && <Stat icon={Coins} title={t("transcript.turnCost")}>{cost}</Stat>}
      {stats && stats.elapsed_ms > 0 && <Stat icon={Clock} title={t("transcript.elapsed")}>{seconds(stats.elapsed_ms)}</Stat>}
      {stopReason === "cancelled" && <span>{t("transcript.stopped")}</span>}
      {endedAt != null && (
        <time dateTime={new Date(endedAt).toISOString()} title={t("transcript.endedAt")} className="ml-auto">
          {clock(endedAt)}
        </time>
      )}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const t = useT();
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
        {t("transcript.thought")}
      </button>
      {open && <p lang={contentLang(text)} className="mt-1 border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</p>}
    </div>
  );
}

export function Transcript({
  items,
  info,
  streaming,
  busy = streaming,
  onResend,
}: {
  items: TranscriptItem[];
  info: SessionInfo | null;
  streaming: boolean;
  /** Mid-turn (including waiting on a permission prompt). Can't resend mid-turn */
  busy?: boolean;
  /** Send the user's own message (possibly edited) as a new turn */
  onResend?: (text: string, attachments: Attached[]) => void;
}) {
  const tr = useT();
  // The user message being edited (index in blocks)
  const [editing, setEditing] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Follow new output only while the view is at the bottom; reading further up is never interrupted
  const atBottom = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  // Output arrived while scrolled up (shown as a dot on the button)
  const [unseen, setUnseen] = useState(false);
  const reduced = useReducedMotion();
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottom.current = bottom;
    setAwayFromBottom(!bottom);
    if (bottom) setUnseen(false);
  };
  useEffect(() => {
    if (atBottom.current) end.current?.scrollIntoView({ block: "end" });
    else setUnseen(true);
  }, [items.length, items[items.length - 1]]);
  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  };

  // Group consecutive tool calls into one frame
  const blocks: (TranscriptItem | { kind: "tools"; tools: ToolCall[] })[] = [];
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (it.kind === "tool") {
      if (last && last.kind === "tools") last.tools.push(it);
      else blocks.push({ kind: "tools", tools: [it] });
    } else blocks.push(it);
  }

  return (
    <div className="relative flex min-h-0 grow flex-col">
    <div ref={scroller} onScroll={onScroll} className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-5 pt-4 pb-2">
      {items.length === 0 && <p className="m-auto text-xs text-muted-foreground">{tr("transcript.empty")}</p>}
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "user":
            return (
              <div key={i} className={cn("group flex flex-col items-end gap-1.5 self-end", editing === i ? "w-[78%]" : "max-w-[78%]")}>
                {b.attachments && <SentAttachments items={b.attachments} />}
                {editing === i ? (
                  <EditBox
                    initial={b.text}
                    onCancel={() => setEditing(null)}
                    onSend={(t) => {
                      setEditing(null);
                      onResend?.(t, resendable(b.attachments ?? []));
                    }}
                  />
                ) : (
                  <>
                    {b.text && <div lang={contentLang(b.text)} className="rounded-[10px] bg-muted px-3 py-1.5 leading-relaxed whitespace-pre-wrap select-text">{b.text}</div>}
                    {onResend && (
                      <UserActions
                        text={b.text}
                        busy={busy}
                        onEdit={() => setEditing(i)}
                        onResend={() => onResend(b.text, resendable(b.attachments ?? []))}
                      />
                    )}
                  </>
                )}
              </div>
            );
          case "agent":
            return (
              <div key={i} className="group flex flex-col gap-0.5">
                <Markdown text={b.text} streaming={streaming && i === blocks.length - 1} />
                {!(streaming && i === blocks.length - 1) && (
                  <ActionRow align="start">
                    <CopyButton text={b.text} />
                  </ActionRow>
                )}
              </div>
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
                  {tr("transcript.plan")}
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
                <TurnStatsRow stats={b.stats} error={b.error} stopReason={b.stopReason} cost={undefined} endedAt={b.endedAt} />
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
      {streaming && (
        <div className="flex items-center gap-3">
          <Working label={workingLabel(items)} />
          {info?.live && (
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
        </div>
      )}
      <div ref={end} />
      {info?.cost && <span className="sr-only">{tr("transcript.sessionCost", { cost: money(info.cost.amount, info.cost.currency) })}</span>}
    </div>
    {/* Shown only while scrolled up; a dot means new output arrived below */}
    <AnimatePresence>
      {awayFromBottom && (
        <motion.button
          key="to-bottom"
          type="button"
          aria-label={unseen ? `${tr("transcript.scrollToBottom")}. ${tr("transcript.newBelow")}` : tr("transcript.scrollToBottom")}
          title={tr("transcript.scrollToBottom")}
          initial={{ opacity: 0, y: 8, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.9 }}
          transition={snappy}
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -ml-4 flex size-8 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-[0_4px_12px_rgba(0,0,0,.45)] hover:bg-accent hover:text-foreground"
        >
          <ArrowDown className="size-4" aria-hidden />
          {unseen && <span aria-hidden className="absolute top-0.5 right-0.5 size-2 rounded-full border-2 border-card bg-foreground" />}
        </motion.button>
      )}
    </AnimatePresence>
    </div>
  );
}
