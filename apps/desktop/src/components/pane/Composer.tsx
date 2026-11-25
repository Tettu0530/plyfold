import { ArrowUp, CornerDownRight, Minimize2, ListOrdered, ListPlus, Paperclip, Pencil, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { money, tokens } from "@/lib/format";
import type { Category, ConfigOption, SessionInfo, SlashCommand } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isDangerMode, ModeIcon, modeLabel } from "../icons";
import { Keys } from "../Keys";
import { SplitFlap } from "../SplitFlap";
import { CHIP_TRIGGER, COMPOSER_PRIMARY_BUTTON } from "./chip";
import { smooth } from "../motion";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";
import type { Attached } from "@/lib/attachments";
import { AttachBox, useAttachments } from "./Attachments";
import { MentionMenu, removeMention, useMention } from "./Mention";
import { commandAt, ghostHint, SlashMenu, useSlash } from "./Slash";
import { useAutoGrow } from "./autoGrow";
import { isImeKey, isSendKey } from "@/lib/keys";
import { useStore, type Queued } from "@/state/store";
import { useT } from "@/i18n";
import { ModelMenu } from "./ModelMenu";

function option(info: SessionInfo | null, c: Category): ConfigOption | undefined {
  return info?.config.find((o) => o.category === c);
}

function currentMode(info: SessionInfo | null): string | null {
  return option(info, "mode")?.current ?? info?.current_mode ?? null;
}

function modeChoices(info: SessionInfo | null): string[] {
  const o = option(info, "mode");
  if (o) return o.choices.map((c) => c.value);
  return info?.modes.map((m) => m.value) ?? [];
}

/** Context usage. Click to show the breakdown */
function ContextMeter({
  info,
  pct,
  scope,
  onCompact,
  compactDisabled,
}: {
  info: SessionInfo;
  pct: number;
  scope: string;
  onCompact?: () => void;
  compactDisabled?: boolean;
}) {
  const anchor = `${scope}:ctx`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  const raised = useLiquidActiveAnchors().has(anchor);
  const t = useT();
  const total = info.total;
  const rows: [string, string][] = [
    [t("composer.inputTotal"), tokens(total.input + total.cached_read + total.cached_write)],
    [t("composer.cachedPart"), tokens(total.cached_read + total.cached_write)],
    [t("composer.outputTotal"), tokens(total.output)],
    [t("composer.costTotal"), info.cost ? money(info.cost.amount, info.cost.currency) : "—"],
  ];
  return (
    <Popover onOpenChange={menu.onOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={liquidAnchor(anchor)}
          type="button"
          aria-label={t("composer.contextDetails")}
          className={cn(
            "relative flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-muted-foreground tabular hover:bg-accent hover:text-foreground data-[state=open]:bg-accent",
            raised && "z-[57]",
          )}
        >
          <span
            role="progressbar"
            aria-label={t("composer.contextUsage")}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1 w-10 overflow-hidden rounded-sm bg-muted"
          >
            <motion.span className="block h-full bg-foreground" animate={{ width: `${pct}%` }} transition={smooth} />
          </span>
          {pct}%
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={menu.ref as React.Ref<HTMLDivElement>}
        style={menu.style}
        side="top"
        align="end"
        className={cn("z-[58] flex w-60 flex-col gap-2 p-3 text-xs", menu.moving && "opacity-0")}
      >
        <div className="flex items-baseline justify-between">
          <span className="font-medium">{t("composer.context")}</span>
          <span className="font-mono tabular">
            {tokens(info.context_used ?? 0)} / {tokens(info.context_size ?? 0)}
          </span>
        </div>
        <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
          <motion.span className="block h-full bg-foreground" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={smooth} />
        </span>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-mono tabular">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-sans text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
        {info.reported_model && (
          <p className="text-muted-foreground">
            {t("composer.reportedModel")} <span className="font-mono text-foreground">{info.reported_model}</span>
          </p>
        )}
        {onCompact && (
          <button
            type="button"
            disabled={compactDisabled}
            onClick={onCompact}
            className="flex items-center justify-center gap-1.5 rounded-md border border-input px-2 py-1.5 hover:bg-accent disabled:opacity-40"
          >
            <Minimize2 className="size-3.5" aria-hidden />
            {t("composer.compactContext")}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Right above the input: model / effort / mode, and context usage */
export function ControlRow({
  agent,
  info,
  onSet,
  empty,
  scope,
  noPickers = false,
  noMode = false,
  showContext = true,
  onCompact,
  compactDisabled,
}: {
  agent: string;
  info: SessionInfo | null;
  onSet: (c: Category, v: string) => void;
  /** Text shown while the config options are not known yet */
  empty?: string;
  /** Per-pane name for the separation animation's origin (session or draft id) */
  scope: string;
  /** No model, effort or mode pickers (the side chat), only the context meter */
  noPickers?: boolean;
  /** No mode picker (an everyday conversation keeps the mode Plyfold chose) */
  noMode?: boolean;
  /** Hide context usage while composing a new session */
  showContext?: boolean;
  onCompact?: () => void;
  compactDisabled?: boolean;
}) {
  const t = useT();
  const raised = useLiquidActiveAnchors();
  const modeMenu = useLiquidMenu(`menu:${scope}:mode`, `${scope}:mode`);
  // The side chat keeps the main session's model and effort: changing them would drop the prompt cache it shares
  const model = noPickers ? null : option(info, "model");
  const effort = noPickers ? null : option(info, "thought_level");
  const mode = currentMode(info);
  const modes = noPickers || noMode ? [] : modeChoices(info);
  const ctxPct = info?.context_used != null && info.context_size ? Math.round((info.context_used / info.context_size) * 100) : null;

  return (
    <div data-composer-controls className="flex items-center gap-0.5 text-xs">
      {/* Model and effort: one chip, one menu (effort in a submenu) */}
      <ModelMenu scope={scope} agent={agent} model={model} effort={effort} onSet={onSet} />
      {/* Mode: a picker like model and effort; ⇧⇥ in the input still cycles through the modes (the label flips) */}
      {modes.length > 0 && (
        <Select value={mode ?? undefined} onValueChange={(v) => onSet("mode", v)} onOpenChange={modeMenu.onOpenChange}>
          <SelectTrigger
            ref={liquidAnchor(`${scope}:mode`)}
            aria-label={t("composer.switchMode", { mode: modeLabel(mode) })}
            className={cn(
              CHIP_TRIGGER,
              "relative gap-1.5 border",
              isDangerMode(mode) ? "border-error/40 text-error" : "border-border",
              raised.has(`${scope}:mode`) && "z-[57]",
            )}
          >
            <SplitFlap
              value={mode ?? ""}
              render={(m) => (
                <>
                  <ModeIcon mode={m || null} />
                  {modeLabel(m || null)}
                </>
              )}
            />
            <Keys keys={["shift", "tab"]} />
          </SelectTrigger>
          <SelectContent
            ref={modeMenu.ref as React.Ref<HTMLDivElement>}
            style={modeMenu.style}
            position="popper"
            side="top"
            align="start"
            sideOffset={6}
            className={cn("z-[58]", modeMenu.moving && "opacity-0")}
          >
            {modes.map((m) => (
              <SelectItem key={m} value={m} className={cn(isDangerMode(m) && "text-error")}>
                <span className="flex items-center gap-1.5">
                  <ModeIcon mode={m} />
                  {modeLabel(m)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {empty && !model && !effort && modes.length === 0 && <span className="px-1.5 text-muted-foreground">{empty}</span>}
      <span className="grow" />
      {showContext && ctxPct != null && info && <ContextMeter info={info} pct={ctxPct} scope={scope} onCompact={onCompact} compactDisabled={compactDisabled} />}
    </div>
  );
}

/** Messages sent mid-turn. Sent in order from the front once the turn ends */
function QueueList({
  scope,
  items,
  busy,
  onRemove,
  onSendNow,
}: {
  scope: string;
  items: Queued[];
  busy: boolean;
  onRemove: (key: string) => void;
  onSendNow: () => void;
}) {
  const t = useT();
  const { editQueued, saveQueued } = useStore.getState();
  const held = items[0]?.editing;
  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && (
        <motion.div
          key="queue"
          data-composer-queue
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={smooth}
          className="overflow-hidden"
        >
          <div className="flex flex-col gap-0.5 pb-1">
            <div className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
              <ListOrdered className="size-3.5" aria-hidden />
              {held ? t("composer.queueHeldWhileEditing") : busy ? t("composer.queueSendAfterTurn") : t("composer.queueUnsent")}
              <span className="font-mono tabular">{items.length}</span>
              {!busy && !held && (
                <button type="button" onClick={onSendNow} className="ml-auto flex h-6 items-center gap-1 rounded-md px-1.5 text-foreground hover:bg-accent">
                  <ArrowUp className="size-3" aria-hidden />
                  {t("composer.sendFirst")}
                </button>
              )}
            </div>
            <AnimatePresence initial={false}>
              {items.map((q) => (
                <motion.div
                  key={q.key}
                  layout="position"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={smooth}
                  className={cn("flex min-h-7 items-center gap-2 rounded-md bg-card pr-0.5 pl-2.5", q.editing && "outline outline-ring")}
                >
                  <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {q.editing ? (
                    <QueueEdit initial={q.text} onSave={(text) => saveQueued(scope, q.key, text)} onCancel={() => editQueued(scope, q.key, false)} />
                  ) : (
                    <span className="min-w-0 grow cursor-text truncate" title={t("composer.editQueued")} onDoubleClick={() => editQueued(scope, q.key, true)}>
                      {q.text || q.attachments.map((a) => a.preview.name).join(" ")}
                    </span>
                  )}
                  {q.attachments.length > 0 && (
                    <Paperclip className="size-3 shrink-0 text-muted-foreground" aria-label={t("composer.attachmentsCount", { count: q.attachments.length })} />
                  )}
                  {!q.editing && (
                    <button
                      type="button"
                      aria-label={t("composer.editQueued")}
                      title={t("composer.editQueued")}
                      onClick={() => editQueued(scope, q.key, true)}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Pencil className="size-3" aria-hidden />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={t("composer.removeFromQueue")}
                    onClick={() => onRemove(q.key)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Editing a queued message in place: ⏎ saves (⇧⏎ for a new line), esc cancels, leaving the field saves */
function QueueEdit({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const ref = useAutoGrow(text);
  const save = () => {
    if (done.current) return;
    done.current = true;
    if (text.trim()) onSave(text.trim());
    else onCancel();
  };
  return (
    <textarea
      ref={ref}
      aria-label={t("composer.editQueued")}
      value={text}
      autoFocus
      rows={1}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !isImeKey(e)) {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={save}
      className="min-w-0 grow resize-none bg-transparent py-1 leading-relaxed outline-none"
    />
  );
}

/**
 * Drawn behind the composer's textarea while its text starts with a whole slash command: the same text, laid out the
 * same way, with the command in blue and the command's input hint after "/name ". The textarea's own text is
 * transparent then, so typing, the caret, selection and IME input are untouched
 */
function CommandLayer({
  text,
  name,
  ghost,
  textRef,
}: {
  text: string;
  name: string;
  ghost: string | null;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Follow the textarea's scroll when it is taller than its box
  useEffect(() => {
    if (ref.current && textRef.current) ref.current.scrollTop = textRef.current.scrollTop;
  });
  const head = name.length + 1;
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden py-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
      <span className="text-command">{text.slice(0, head)}</span>
      {text.slice(head)}
      {ghost && <span className="text-muted-foreground">{ghost}</span>}
    </div>
  );
}

export function Composer({
  scope,
  agent,
  info,
  disabled,
  busy = false,
  placeholder,
  onSend,
  onSet,
  onStop,
  queue = [],
  onUnqueue,
  onSendQueued,
  root = null,
  commands,
  noPickers = false,
  noMode = false,
}: {
  scope: string;
  agent: string;
  info: SessionInfo | null;
  disabled: boolean;
  /** Mid-turn (sending queues the message; with empty text the send button becomes stop) */
  busy?: boolean;
  placeholder: string;
  onSend: (text: string, attachments: Attached[]) => void;
  onSet: (c: Category, v: string) => void;
  onStop?: () => void;
  queue?: Queued[];
  onUnqueue?: (key: string) => void;
  onSendQueued?: () => void;
  /** Working directory for @-mentions (the session's worktree or repository) */
  root?: string | null;
  /** Slash commands to complete after "/" */
  commands?: SlashCommand[];
  /** Hide the model, effort and mode pickers, and ⇧⇥ (the side chat) */
  noPickers?: boolean;
  /** Hide only the mode picker and ⇧⇥ (an everyday conversation) */
  noMode?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");
  // A chip added with @ and its "@path" in the text are kept together: removing either removes the other
  const att = useAttachments({ scope: scope, onMentionRemoved: (path) => setText((cur) => removeMention(cur, path)) });
  const sendKey = useStore((s) => s.settings.send_key ?? "enter");
  const textRef = useAutoGrow(text);
  const mention = useMention({ root, text, setText, textRef, boxRef: att.boxRef, scope, onPick: (h) => att.addMention(h.abs, h.path) });
  // "/" at the start lists the agent's slash commands
  const cmds = commands ?? info?.commands ?? [];
  const supportsCompaction = cmds.some((command) => command.name === "compact");
  const models = option(info, "model")?.choices.map((c) => c.value) ?? [];
  const slash = useSlash({ commands: cmds, models, text, setText, textRef, boxRef: att.boxRef, scope });
  // A whole command at the start is shown in blue, and its input hint faintly after "/name " (see CommandLayer)
  const command = commandAt(text, cmds);
  const ghost = ghostHint(text, slash.caret, cmds);
  useEffect(() => {
    att.syncMentions(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  // Text sent here from elsewhere (an answer from the side chat), or just a request for focus (empty text)
  const insert = useStore((s) => (s.composerInsert?.scope === scope ? s.composerInsert : null));
  useEffect(() => {
    if (!insert) return;
    if (insert.text) setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${insert.text}` : insert.text));
    textRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert?.n]);
  const canSend = !disabled && (!!text.trim() || att.items.length > 0);
  // Mid-turn with empty text, the send button becomes stop
  const stopMode = busy && !text.trim() && att.items.length === 0 && !!onStop;
  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), att.items);
    setText("");
    att.clear();
  };
  const modes = noPickers || noMode ? [] : modeChoices(info);
  const mode = currentMode(info);

  return (
    // Same width as the conversation above in a wide pane (its edges line up with the messages, as in a narrow one)
    <div data-session-composer className="flex shrink-0 flex-col gap-1 px-[max(0.75rem,calc((100%_-_53rem)/2))] pb-3">
      <QueueList scope={scope} items={queue} busy={busy} onRemove={(k) => onUnqueue?.(k)} onSendNow={() => onSendQueued?.()} />
      <ControlRow
        scope={scope}
        agent={agent}
        info={info}
        onSet={onSet}
        noPickers={noPickers}
        noMode={noMode}
        onCompact={supportsCompaction ? () => onSend("/compact", []) : undefined}
        compactDisabled={disabled || busy}
      />
      <MentionMenu m={mention} boxRef={att.boxRef} />
      <SlashMenu m={slash} boxRef={att.boxRef} />
      <AttachBox att={att}>
        <div className="relative flex min-h-0 grow">
          {command && <CommandLayer text={text} name={command.name} ghost={ghost} textRef={textRef} />}
          <textarea
            ref={textRef}
            aria-label={t("composer.message")}
            rows={1}
            value={text}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              mention.syncCaret();
              slash.syncCaret();
            }}
            onSelect={() => {
              mention.syncCaret();
              slash.syncCaret();
            }}
            onKeyDown={(e) => {
              // The @-mention list takes ↑↓, ⏎, ⇥ and esc while it is open
              if (mention.onKeyDown(e) || slash.onKeyDown(e)) return;
              if (isSendKey(e, sendKey)) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape" && busy && onStop && !isImeKey(e)) {
                // While working, esc interrupts (same as Claude Code)
                e.preventDefault();
                onStop();
              } else if (e.key === "Tab" && e.shiftKey && modes.length > 0) {
                e.preventDefault();
                const i = mode ? modes.indexOf(mode) : -1;
                onSet("mode", modes[(i + 1) % modes.length]);
              }
            }}
            onScroll={(e) => {
              const layer = e.currentTarget.previousElementSibling as HTMLElement | null;
              if (layer) layer.scrollTop = e.currentTarget.scrollTop;
            }}
            className={cn(
              "relative min-h-0 w-full grow resize-none bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground",
              // The layer behind draws the text while a command is recognised; the caret and selection stay here
              command && "text-transparent caret-foreground",
            )}
          />
        </div>
        {stopMode ? (
          <button type="button" aria-label={t("composer.stopEsc")} title={t("composer.stopEsc")} onClick={onStop} className={COMPOSER_PRIMARY_BUTTON}>
            <Square className="size-3 fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            aria-label={busy ? t("composer.addToQueue") : t("composer.send")}
            title={busy ? t("composer.addToQueueHint") : undefined}
            disabled={!canSend}
            onClick={send}
            className={COMPOSER_PRIMARY_BUTTON}
          >
            {busy ? <ListPlus className="size-3.5" aria-hidden /> : <ArrowUp className="size-3.5" aria-hidden />}
          </button>
        )}
      </AttachBox>
    </div>
  );
}
