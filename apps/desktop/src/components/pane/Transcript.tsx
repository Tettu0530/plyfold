import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronUp, Clock, Coins, Gauge, Info, ListChecks, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";

import { useT, contentLang } from "@/i18n";
import { money, seconds, tokens } from "@/lib/format";
import { isImeKey } from "@/lib/keys";
import type { SessionInfo, SlashCommand, TurnStats } from "@/lib/types";
import { cn } from "@/lib/utils";
import { findMatches, MIN_QUERY } from "@/state/find";
import { INTERRUPTED, type ToolCall, type TranscriptItem } from "@/state/transcript";
import { Marked } from "./Marked";
import { resendable, type Attached } from "@/lib/attachments";
import { SentAttachments } from "./Attachments";
import { Markdown } from "./Markdown";
import { ShellBlock } from "./ShellBlock";
import { ActionRow, CopyButton, EditBox, QuoteButton, SendBackButton, UserActions, Working, workingLabel } from "./MessageActions";
import { ToolCalls } from "./ToolCall";
import { bouncy, smooth } from "../motion";
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
  showMissingRate = false,
}: {
  stats: TurnStats | null;
  showMissingRate?: boolean;
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
      {stats?.tokens_per_sec != null || showMissingRate ? (
        <Stat icon={Gauge} title={stats?.estimated && !showMissingRate ? t("transcript.tokPerSecEstimated") : t("transcript.tokPerSec")}>
          {stats?.tokens_per_sec == null ? "-" : `${stats.estimated ? "~" : ""}${Math.round(stats.tokens_per_sec)} tok/s`}
        </Stat>
      ) : null}
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
      {/* Thinking is written in Markdown like answers (lists, emphasis, code); shown small and muted, headings
          included, so it stays a side note */}
      {open && (
        <div className="mt-1 border-l pl-3 text-xs leading-relaxed text-muted-foreground [&_:is(h3,h4,h5,h6)]:text-xs [&_:is(h3,h4,h5,h6)]:text-foreground/80">
          <Markdown text={text} />
        </div>
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

/**
 * Scroll to the bottom. When new output arrives below while it is shown, its dot pops in and the arrow dips once
 * (no looping)
 */
function ToBottomButton({ unseen, label, title, onClick }: { unseen: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className="relative flex size-8 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-[0_4px_12px_rgba(0,0,0,.45)] hover:bg-accent hover:text-foreground"
    >
      <motion.span
        key={unseen ? "new" : "idle"}
        initial={unseen ? { y: 0 } : false}
        animate={unseen ? { y: [0, 3, 0] } : { y: 0 }}
        transition={{ duration: 0.45 }}
        className="flex"
      >
        <ArrowDown className="size-4" aria-hidden />
      </motion.span>
      <AnimatePresence>
        {unseen && (
          <motion.span
            key="dot"
            aria-hidden
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={bouncy}
            className="absolute top-0.5 right-0.5 size-2 rounded-full border-2 border-card bg-foreground"
          />
        )}
      </AnimatePresence>
    </button>
  );
}

/**
 * Tool calls that follow one another share a summary; any other item (a message, thinking, a plan) ends the run, so each
 * summary sits where those calls happened in the conversation.
 */
const NO_COMMANDS: SlashCommand[] = [];
export type ToolGroup = { kind: "tools"; itemIndex: number; tools: { tool: ToolCall; itemIndex: number }[] };
export function groupTools(items: TranscriptItem[]): ((TranscriptItem & { itemIndex: number }) | ToolGroup)[] {
  const grouped: ((TranscriptItem & { itemIndex: number }) | ToolGroup)[] = [];
  let group: ToolGroup | undefined;
  items.forEach((item, itemIndex) => {
    if (item.kind === "tool") {
      if (!group) {
        group = { kind: "tools", itemIndex, tools: [] };
        grouped.push(group);
      }
      group.tools.push({ tool: item, itemIndex });
    } else {
      group = undefined;
      grouped.push({ ...item, itemIndex });
    }
  });
  return grouped;
}

type Block = ReturnType<typeof groupTools>[number];

/** Whether two blocks show the same thing (groupTools builds new objects on every call, so identity is not enough) */
function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const key of keys) {
    if (Object.is(x[key], y[key])) continue;
    const xs = x[key];
    const ys = y[key];
    // The calls of a tool group: same tool objects at the same positions
    if (key === "tools" && Array.isArray(xs) && Array.isArray(ys) && xs.length === ys.length) {
      if (
        xs.every((row: { tool: unknown; itemIndex: number }, k) => row.tool === (ys[k] as typeof row).tool && row.itemIndex === (ys[k] as typeof row).itemIndex)
      )
        continue;
    }
    return false;
  }
  return true;
}

/**
 * Turns far from the view are not rendered: a box of the height they last had stands in for them. A long session has
 * thousands of blocks, and the browser (WebKit in particular) spends its time on all of them whenever the width changes.
 */
interface LazyApi {
  /** Calls `onNear` when the box comes within reach of the view (and again when it leaves) */
  watch(el: HTMLElement, onNear: (near: boolean) => void): () => void;
  /** The height to hold for a turn that is not rendered */
  height(key: number): number;
}
const LazyContext = createContext<LazyApi | null>(null);
/** How far outside the view (in px, each way) turns are kept rendered: about two screens */
const NEAR = 1500;
const DEFAULT_HEIGHT = 400;
const CAN_LAZY = typeof IntersectionObserver !== "undefined" && typeof ResizeObserver !== "undefined";

function useLazyApi(root: HTMLElement | null): LazyApi | null {
  return useMemo(() => {
    if (!root || !CAN_LAZY) return null;
    const callbacks = new Map<Element, (near: boolean) => void>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
      },
      { root, rootMargin: `${NEAR}px 0px` },
    );
    const heights = new Map<number, number>();
    const last = new WeakMap<Element, number>();
    const average = () => {
      if (heights.size === 0) return DEFAULT_HEIGHT;
      let sum = 0;
      for (const h of heights.values()) sum += h;
      return Math.round(sum / heights.size);
    };
    let tuned = DEFAULT_HEIGHT;
    const ro = new ResizeObserver((entries) => {
      const top = root.getBoundingClientRect().top;
      let shift = 0;
      // Moves what is read when a turn above the view changes height (its old bottom edge was above the view)
      const settle = (el: Element, h: number, before: number | undefined) => {
        if (before !== undefined && h !== before && el.getBoundingClientRect().bottom - (h - before) <= top) shift += h - before;
      };
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
        const before = last.get(el);
        last.set(el, h);
        if (el.dataset.shown === "1") heights.set(Number(el.dataset.key), h);
        settle(el, h, before);
      }
      // Turns never seen yet stand in with the average of those that were: the length of the scrollbar settles quickly
      const avg = average();
      if (Math.abs(avg - tuned) > tuned * 0.05) {
        tuned = avg;
        for (const el of callbacks.keys() as IterableIterator<HTMLElement>) {
          if (el.dataset.shown !== "0" || heights.has(Number(el.dataset.key))) continue;
          const before = last.get(el);
          el.style.height = `${avg}px`;
          last.set(el, avg);
          settle(el, avg, before);
        }
      }
      if (shift) root.scrollTop += shift;
    });
    return {
      watch(el, onNear) {
        callbacks.set(el, onNear);
        io.observe(el);
        ro.observe(el);
        return () => {
          callbacks.delete(el);
          io.unobserve(el);
          ro.unobserve(el);
        };
      },
      height(key) {
        return heights.get(key) ?? average();
      },
    };
  }, [root]);
}

interface SegmentProps {
  /** One turn: a user message and what followed it (or the items before the first message) */
  blocks: Block[];
  isLast: boolean;
  /** Rendered from the start (the turns at the end, where the view opens) */
  eager: boolean;
  /** Kept rendered wherever it is (it holds the find match or the message being edited) */
  pinned: boolean;
  /** The turn is being worked on (only ever true for the last segment) */
  live: boolean;
  streaming: boolean;
  busy: boolean;
  lastItem: number;
  editing: number | null;
  setEditing: (index: number | null) => void;
  finding: boolean;
  query: string;
  currentItem: number | null;
  currentOccurrence: number | null;
  permissionTool?: string;
  commands: SlashCommand[];
  base?: string;
  sessionId?: string;
  onResend?: (text: string, attachments: Attached[]) => void;
  onQuote?: { label: string; run: (text: string) => void };
  onSendBack?: { label: string; run: (text: string) => void };
}

// A local command (no tokens either way) has nothing to report; a stop or an error still shows
const showStats = (b: Extract<TranscriptItem, { kind: "stats" }>) =>
  !!b.error || b.stopReason === "cancelled" || b.stopReason === INTERRUPTED || !usedNoTokens(b.stats);

/**
 * One turn of the conversation. Memoised, so a turn that did not change is not rendered again while the last one streams
 * or while the input is typed in; and it is one box for the browser's content-visibility, so the turns that are scrolled
 * out of view cost no layout (a long session has thousands of blocks).
 */
const Segment = memo(
  function Segment({
    blocks,
    isLast,
    eager,
    pinned,
    live,
    streaming,
    busy,
    lastItem,
    editing,
    setEditing,
    finding,
    query,
    currentItem,
    currentOccurrence,
    permissionTool,
    commands,
    base,
    sessionId,
    onResend,
    onQuote,
    onSendBack,
  }: SegmentProps) {
    const tr = useT();
    const lazy = useContext(LazyContext);
    const ref = useRef<HTMLDivElement>(null);
    const key = blocks[0].itemIndex;
    const [near, setNear] = useState(eager);
    // Without IntersectionObserver (tests, server rendering) everything is rendered. The observer exists a moment after
    // the first render; until then only the turns at the end are, so the view does not open on a screenful of the wrong height
    const shown = !CAN_LAZY || near || pinned || isLast;
    useEffect(() => {
      const el = ref.current;
      if (!lazy || !el) return;
      return lazy.watch(el, setNear);
    }, [lazy]);
    const find = { query };
    const current = currentItem == null ? undefined : { itemIndex: currentItem, occurrence: currentOccurrence ?? 0 };
    const occurrenceIn = (itemIndex: number) => (current?.itemIndex === itemIndex ? current.occurrence : null);
    // Only the last answer of a finished turn gets actions and turn statistics.
    const statsOf = new Map<number, Extract<TranscriptItem, { kind: "stats" }>>();
    const attached = new Set<number>();
    const finalAnswers = new Set<number>();
    let lastAgent: number | null = null;
    blocks.forEach((block, index) => {
      if (block.kind === "user") {
        if (lastAgent !== null) finalAnswers.add(lastAgent);
        lastAgent = null;
      } else if (block.kind === "agent") {
        lastAgent = index;
      } else if (block.kind === "stats") {
        if (lastAgent !== null) finalAnswers.add(lastAgent);
        if (!block.error && lastAgent !== null) {
          statsOf.set(lastAgent, block);
          attached.add(index);
        }
        lastAgent = null;
      }
    });
    if (!live && lastAgent !== null) finalAnswers.add(lastAgent);
    return (
      <div
        ref={ref}
        data-key={key}
        data-shown={shown ? "1" : "0"}
        className="flex shrink-0 flex-col gap-3"
        style={shown ? undefined : { height: lazy?.height(key) ?? DEFAULT_HEIGHT }}
      >
        {shown &&
          blocks.map((b, i) => {
            switch (b.kind) {
              case "user":
                return (
                  <div
                    key={b.itemIndex}
                    data-find-item={b.itemIndex}
                    className={cn("group flex flex-col items-end gap-1.5 self-end", editing === b.itemIndex ? "w-[78%]" : "max-w-[78%]")}
                  >
                    {b.attachments && <SentAttachments items={b.attachments} />}
                    {editing === b.itemIndex ? (
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
                            {finding ? (
                              <Marked text={b.text} query={find.query} active={occurrenceIn(b.itemIndex)} />
                            ) : (
                              <CommandText text={b.text} commands={commands} />
                            )}
                          </div>
                        )}
                        {onResend && (
                          <UserActions
                            text={b.text}
                            busy={busy}
                            onEdit={() => setEditing(b.itemIndex)}
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
                    {onSendBack && <SendBackButton text={b.text} label={onSendBack.label} onSend={onSendBack.run} />}
                  </ActionRow>
                );
                const st = statsOf.get(i);
                return (
                  <div key={b.itemIndex} data-find-item={b.itemIndex} className="group flex flex-col gap-0.5">
                    <Markdown
                      text={b.text}
                      streaming={streaming && b.itemIndex === lastItem}
                      base={base}
                      needle={finding ? find.query : undefined}
                      activeOccurrence={occurrenceIn(b.itemIndex)}
                    />
                    {finalAnswers.has(i) &&
                      (st && showStats(st) ? (
                        <TurnStatsRow stats={st.stats} stopReason={st.stopReason} cost={undefined} endedAt={st.endedAt} actions={actions} />
                      ) : (
                        actions
                      ))}
                  </div>
                );
              }
              case "thought":
                return <Thought key={b.itemIndex} text={b.text} />;
              case "tools":
                return (
                  <div key={b.itemIndex} className="flex flex-col gap-3">
                    <ToolCalls
                      tools={b.tools}
                      permissionTool={typeof permissionTool === "string" ? permissionTool : undefined}
                      find={finding ? { query: find.query, activeItem: current?.itemIndex ?? null, activeOccurrence: current?.occurrence ?? null } : undefined}
                    />
                  </div>
                );
              case "plan":
                return (
                  <div key={b.itemIndex} className="rounded-[10px] border bg-card px-3 py-2">
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
                  <div key={b.itemIndex} className="flex flex-col gap-3">
                    {/* Shown under the answer when there is one (see statsOf) */}
                    {!attached.has(i) && showStats(b) && (
                      <TurnStatsRow stats={b.stats} error={b.error} stopReason={b.stopReason} cost={undefined} endedAt={b.endedAt} />
                    )}
                    {!(isLast && i === blocks.length - 1) && <div className="h-px bg-border" />}
                  </div>
                );
              case "shell":
                return (
                  <div key={b.itemIndex} data-find-item={b.itemIndex}>
                    <ShellBlock item={b} sessionId={sessionId} />
                  </div>
                );
              case "notice":
                return (
                  <p key={b.itemIndex} className="m-0 flex gap-2 text-xs whitespace-pre-wrap text-muted-foreground">
                    <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {b.text}
                  </p>
                );
            }
          })}
      </div>
    );
  },
  (a, b) => {
    const keys = Object.keys(a) as (keyof SegmentProps)[];
    for (const key of keys) {
      if (key === "blocks") {
        if (a.blocks.length !== b.blocks.length || !a.blocks.every((block, k) => sameBlock(block, b.blocks[k]))) return false;
      } else if (!Object.is(a[key], b[key])) return false;
    }
    return true;
  },
);

export function Transcript({
  items,
  info,
  streaming,
  busy = streaming,
  onResend,
  onQuote,
  onSendBack,
  compact = false,
  commands = NO_COMMANDS,
  base,
  sessionId,
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
  /** Send an answer to another session as an instruction; shown next to the quote button */
  onSendBack?: { label: string; run: (text: string) => void };
  /** A narrow column (the side chat): no centred reading width, tighter padding */
  compact?: boolean;
  /** The agent's slash commands: a message that starts with one shows it in blue, as the composer does */
  commands?: SlashCommand[];
  /** The session's folder: relative image paths in answers start here */
  base?: string;
  /** When set, ⌘F for this session shows the find bar and scrolls to its match. The side chat leaves it unset */
  sessionId?: string;
}) {
  const tr = useT();
  // The user message being edited (index in items)
  const [editing, setEditing] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => setRoot(scroller.current), []);
  const lazy = useLazyApi(root);
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
  const find = useStore((s) => (sessionId && s.find?.sessionId === sessionId ? s.find : null));
  const permissionTool = useStore((s) => (sessionId ? s.sessions[sessionId]?.permission?.toolCall.toolCallId : undefined));
  const setFindQuery = useStore((s) => s.setFindQuery);
  const stepFind = useStore((s) => s.stepFind);
  const closeFind = useStore((s) => s.closeFind);
  const matches = useMemo(() => (find ? findMatches(items, find.query) : []), [find, items]);
  const activeIndex = find && matches.length ? Math.min(find.active, matches.length - 1) : 0;
  const current = matches[activeIndex];
  const findInput = useRef<HTMLInputElement>(null);
  // Focus the field when the bar opens, not again on each step
  useEffect(() => {
    if (find) findInput.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find?.sessionId]);
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    const m = currentRef.current;
    if (!m) return;
    const root = scroller.current;
    const item = root?.querySelector<HTMLElement>(`[data-find-item="${m.itemIndex}"]`);
    const hit = item?.querySelector<HTMLElement>(`[data-find-hit="${m.occurrence}"]`);
    (hit ?? item)?.scrollIntoView({ block: "center" });
    atBottom.current = false;
    setAwayFromBottom(true);
  }, [find?.token]);

  // Follow new output (a new item, or the last one growing while it streams). Not while a find result is being shown
  const last = items[items.length - 1];
  const finding = !!find && find.query.trim().length >= MIN_QUERY;
  useEffect(() => {
    if (finding) return;
    if (atBottom.current) end.current?.scrollIntoView({ block: "end" });
    else setUnseen(true);
  }, [items.length, last, finding]);
  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    // Near the end the scroll glides. From far away it jumps: the turns on the way are drawn as they come into reach and
    // change the height under a glide, which would stop it short. After the jump, follow any change of height until the end
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 3;
    if (!far) {
      el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
      return;
    }
    const until = performance.now() + 2500;
    let steady = 0;
    const settle = () => {
      el.scrollTop = el.scrollHeight;
      steady = el.scrollHeight - el.scrollTop - el.clientHeight > 1 ? 0 : steady + 1;
      if (steady < 8 && performance.now() < until) requestAnimationFrame(settle);
    };
    settle();
  };

  const blocks = useMemo(() => groupTools(items), [items]);
  // Segments are cut at each user message; what stays the same keeps its identity, so Segment can skip it
  const segments = useMemo(() => {
    const out: Block[][] = [];
    for (const block of blocks) {
      if (block.kind === "user" || out.length === 0) out.push([block]);
      else out[out.length - 1].push(block);
    }
    return out;
  }, [blocks]);
  const work = streaming ? workingLabel(items) : null;
  const thinking = work === "message.thinking";
  // The callbacks come from the parent as new closures on every render; the segments see steady ones
  const handlers = useRef({ onResend, onQuote, onSendBack });
  handlers.current = { onResend, onQuote, onSendBack };
  const hasResend = !!onResend;
  const quoteLabel = onQuote?.label;
  const sendBackLabel = onSendBack?.label;
  const resend = useMemo(
    () => (hasResend ? (text: string, attachments: Attached[]) => handlers.current.onResend?.(text, attachments) : undefined),
    [hasResend],
  );
  const quote = useMemo(
    () => (quoteLabel !== undefined ? { label: quoteLabel, run: (text: string) => handlers.current.onQuote?.run(text) } : undefined),
    [quoteLabel],
  );
  const sendBack = useMemo(
    () => (sendBackLabel !== undefined ? { label: sendBackLabel, run: (text: string) => handlers.current.onSendBack?.run(text) } : undefined),
    [sendBackLabel],
  );

  return (
    <div data-transcript className="relative flex min-h-0 grow flex-col">
      {find && (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
          <input
            ref={findInput}
            aria-label={tr("transcript.findPlaceholder")}
            placeholder={tr("transcript.findPlaceholder")}
            value={find.query}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeFind();
              } else if (e.key === "Enter" && !isImeKey(e)) {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1, matches.length);
              }
            }}
            className="min-w-0 grow bg-transparent outline-none placeholder:text-muted-foreground"
          />
          <span className="font-mono text-xs text-muted-foreground tabular" aria-live="polite">
            {find.query.trim().length < MIN_QUERY ? "" : matches.length === 0 ? tr("transcript.findNone") : `${activeIndex + 1} / ${matches.length}`}
          </span>
          <button
            type="button"
            aria-label={tr("transcript.findPrevious")}
            disabled={matches.length === 0}
            onClick={() => stepFind(-1, matches.length)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ChevronUp className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={tr("transcript.findNext")}
            disabled={matches.length === 0}
            onClick={() => stepFind(1, matches.length)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={tr("search.close")}
            onClick={() => closeFind()}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
      {/* In a wide pane the conversation keeps a readable width (52rem) in the middle; the padding grows instead, so the
        scrollbar stays at the pane's edge */}
      <div
        ref={scroller}
        data-transcript-scroll
        onScroll={onScroll}
        className={cn("flex min-h-0 grow flex-col gap-3 overflow-y-auto pt-4 pb-2", compact ? "px-3" : "px-[max(1.25rem,calc((100%_-_52rem)/2))]")}
      >
        {items.length === 0 && <p className="m-auto text-xs text-muted-foreground">{tr("transcript.empty")}</p>}
        <LazyContext.Provider value={lazy}>
          {segments.map((segment, s) => {
            const isLast = s === segments.length - 1;
            const first = segment[0].itemIndex;
            const last = segment[segment.length - 1];
            const lastIndex = last.kind === "tools" ? last.tools[last.tools.length - 1].itemIndex : last.itemIndex;
            const inside = (index: number | null | undefined) => (index != null && index >= first && index <= lastIndex ? index : null);
            return (
              <Segment
                key={first}
                blocks={segment}
                isLast={isLast}
                eager={s >= segments.length - 3}
                pinned={inside(editing) != null || inside(current?.itemIndex) != null}
                live={isLast && (busy || streaming)}
                streaming={isLast && streaming}
                busy={busy}
                lastItem={isLast ? items.length - 1 : -1}
                editing={inside(editing)}
                setEditing={setEditing}
                finding={finding}
                query={finding ? find.query : ""}
                currentItem={inside(current?.itemIndex)}
                currentOccurrence={inside(current?.itemIndex) != null ? current!.occurrence : null}
                permissionTool={typeof permissionTool === "string" ? permissionTool : undefined}
                commands={commands}
                base={base}
                sessionId={sessionId}
                onResend={resend}
                onQuote={quote}
                onSendBack={sendBack}
              />
            );
          })}
        </LazyContext.Provider>
        {work && (
          <div className="flex items-center gap-3">
            <Working label={tr(work)} />
            {(info?.live || thinking) && (
              <TurnStatsRow
                showMissingRate={thinking}
                stats={
                  info?.live
                    ? {
                        usage: null,
                        elapsed_ms: info.live.elapsed_ms,
                        ttft_ms: info.live.ttft_ms,
                        tokens_per_sec: thinking ? null : info.live.est_tokens_per_sec,
                        estimated: true,
                      }
                    : null
                }
              />
            )}
          </div>
        )}
        <div ref={end} />
        {info?.cost && <span className="sr-only">{tr("transcript.sessionCost", { cost: money(info.cost.amount, info.cost.currency) })}</span>}
      </div>
      {/* Shown only while scrolled up; a dot means new output arrived below */}
      {/* Materializes in place (no travel): from nothing, slightly small and out of focus */}
      <AnimatePresence>
        {awayFromBottom && (
          <motion.div
            key="to-bottom"
            initial={{ opacity: 0, scale: 0.6, filter: "blur(6px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.6, filter: "blur(6px)" }}
            transition={smooth}
            data-transcript-jump
            className="absolute bottom-3 left-1/2 -ml-4"
          >
            <ToBottomButton
              unseen={unseen}
              label={unseen ? `${tr("transcript.scrollToBottom")}. ${tr("transcript.newBelow")}` : tr("transcript.scrollToBottom")}
              title={tr("transcript.scrollToBottom")}
              onClick={jumpToBottom}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
