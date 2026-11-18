import { ArrowDown, ArrowUp, ChevronRight, Clock, Coins, Gauge, Info, ListChecks } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { useT, contentLang } from "@/i18n";
import { money, seconds, tokens } from "@/lib/format";
import type { SessionInfo, SlashCommand, TurnStats } from "@/lib/types";
import { cn } from "@/lib/utils";
import { INTERRUPTED, type ToolCall, type TranscriptItem } from "@/state/transcript";
import { resendable, type Attached } from "@/lib/attachments";
import { SentAttachments } from "./Attachments";
import { Markdown } from "./Markdown";
import { ActionRow, CopyButton, EditBox, QuoteButton, UserActions, Working, workingLabel } from "./MessageActions";
import { DiffBlock, ToolCalls } from "./ToolCall";
import { snappy } from "../motion";
import { useStore } from "@/state/store";
import { commandAt } from "./Slash";

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

/**
 * A turn that used no tokens at all: a command the agent answers by itself, without the model (/usage, /context…).
 * Only when the agent reports usage; without it nothing is known
 */
export function usedNoTokens(stats: TurnStats | null): boolean {
  const u = stats?.usage;
  return !!u && u.input + u.cached_read + u.cached_write + u.output === 0;
}

export function TurnStatsRow({
  stats,
  cost,
  error,
  stopReason,
  endedAt,
  actions,
}: {
  stats: TurnStats | null;
  cost?: string;
  error?: string | null;
  stopReason?: string | null;
  endedAt?: number | null;
  /** The answer's buttons (copy…), on the left of the numbers */
  actions?: React.ReactNode;
}) {
  const t = useT();
  if (error) return <p className="text-xs text-error">{error}</p>;
  return (
    // The answer's buttons on the left, the numbers on the right
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground tabular">
      {actions}
      <span className="grow" />
      {stats?.tokens_per_sec != null && (
        <Stat icon={Gauge} title={stats.estimated ? t("transcript.tokPerSecEstimated") : t("transcript.tokPerSec")}>
          {stats.estimated ? "~" : ""}
          {Math.round(stats.tokens_per_sec)} tok/s
        </Stat>
      )}
      {stats?.usage && (
        <>
          <Stat icon={ArrowUp} title={t("transcript.inputTokens")}>
            {tokens(stats.usage.input + stats.usage.cached_read + stats.usage.cached_write)}
          </Stat>
          <Stat icon={ArrowDown} title={t("transcript.outputTokens")}>
            {tokens(stats.usage.output)}
          </Stat>
        </>
      )}
      {cost && (
        <Stat icon={Coins} title={t("transcript.turnCost")}>
          {cost}
        </Stat>
      )}
      {stats && stats.elapsed_ms > 0 && (
        <Stat icon={Clock} title={t("transcript.elapsed")}>
          {seconds(stats.elapsed_ms)}
        </Stat>
      )}
      {stopReason === "cancelled" && <span>{t("transcript.stopped")}</span>}
      {stopReason === INTERRUPTED && <span>{t("transcript.interrupted")}</span>}
      {endedAt != null && (
        <time dateTime={new Date(endedAt).toISOString()} title={t("transcript.endedAt")}>
          {clock(endedAt)}
        </time>
      )}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const t = useT();
  // Settings → Thinking: start expanded or collapsed
  const [open, setOpen] = useState(() => useStore.getState().settings.thoughts_expanded === true);
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
      {open && (
        <p lang={contentLang(text)} className="mt-1 border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      )}
    </div>
  );
}

/** A sent message, with a slash command at its start in blue */
function CommandText({ text, commands }: { text: string; commands: SlashCommand[] }) {
  const command = commandAt(text, commands);
  if (!command) return <>{text}</>;
  const head = command.name.length + 1;
  return (
    <>
      <span className="text-command">{text.slice(0, head)}</span>
      {text.slice(head)}
    </>
  );
}

export function Transcript({
  items,
  info,
  streaming,
  busy = streaming,
  onResend,
  onQuote,
  compact = false,
  commands = [],
}: {
  items: TranscriptItem[];
  info: SessionInfo | null;
  streaming: boolean;
  /** Mid-turn (including waiting on a permission prompt). Can't resend mid-turn */
  busy?: boolean;
  /** Send the user's own message (possibly edited) as a new turn */
  onResend?: (text: string, attachments: Attached[]) => void;
  /** Put an answer into another input; shown as a button under each answer, with this label */
  onQuote?: { label: string; run: (text: string) => void };
  /** A narrow column (the side chat): no centred reading width, tighter padding */
  compact?: boolean;
  /** The agent's slash commands: a message that starts with one shows it in blue, as the composer does */
  commands?: SlashCommand[];
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
  // Follows Settings → Reduce motion as well as macOS (through MotionConfig)
  const reduced = !!useReducedMotionConfig();
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottom.current = bottom;
    setAwayFromBottom(!bottom);
    if (bottom) setUnseen(false);
  };
  // Follow new output (a new item, or the last one growing while it streams)
  const last = items[items.length - 1];
  useEffect(() => {
    if (atBottom.current) end.current?.scrollIntoView({ block: "end" });
    else setUnseen(true);
  }, [items.length, last]);
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
  // A turn's numbers go beside the buttons under its last answer (an error, or a turn with no answer, keeps its own row)
  const statsOf = new Map<number, Extract<TranscriptItem, { kind: "stats" }>>();
  const attached = new Set<number>();
  blocks.forEach((b, j) => {
    if (b.kind !== "stats" || b.error) return;
    for (let k = j - 1; k >= 0; k--) {
      const prev = blocks[k];
      if (prev.kind === "user" || prev.kind === "stats") break;
      if (prev.kind === "agent") {
        statsOf.set(k, b);
        attached.add(j);
        break;
      }
    }
  });
  // A local command (no tokens either way) has nothing to report; a stop or an error still shows
  const showStats = (b: Extract<TranscriptItem, { kind: "stats" }>) =>
    !!b.error || b.stopReason === "cancelled" || b.stopReason === INTERRUPTED || !usedNoTokens(b.stats);

  return (
    <div className="relative flex min-h-0 grow flex-col">
      {/* In a wide pane the conversation keeps a readable width (52rem) in the middle; the padding grows instead, so the
        scrollbar stays at the pane's edge */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className={cn("flex min-h-0 grow flex-col gap-3 overflow-y-auto pt-4 pb-2", compact ? "px-3" : "px-[max(1.25rem,calc((100%_-_52rem)/2))]")}
      >
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
                      {b.text && (
                        <div lang={contentLang(b.text)} className="rounded-[10px] bg-muted px-3 py-1.5 leading-relaxed whitespace-pre-wrap select-text">
                          <CommandText text={b.text} commands={commands} />
                        </div>
                      )}
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
            case "agent": {
              const actions = (
                <ActionRow align="start">
                  <CopyButton text={b.text} />
                  {onQuote && <QuoteButton text={b.text} label={onQuote.label} onQuote={onQuote.run} />}
                </ActionRow>
              );
              const st = statsOf.get(i);
              return (
                <div key={i} className="group flex flex-col gap-0.5">
                  <Markdown text={b.text} streaming={streaming && i === blocks.length - 1} />
                  {!(streaming && i === blocks.length - 1) &&
                    (st && showStats(st) ? (
                      <TurnStatsRow stats={st.stats} stopReason={st.stopReason} cost={undefined} endedAt={st.endedAt} actions={actions} />
                    ) : (
                      actions
                    ))}
                </div>
              );
            }
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
                  {/* Shown under the answer when there is one (see statsOf) */}
                  {!attached.has(i) && showStats(b) && (
                    <TurnStatsRow stats={b.stats} error={b.error} stopReason={b.stopReason} cost={undefined} endedAt={b.endedAt} />
                  )}
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
