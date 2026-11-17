import { ArrowUp, ChevronsUpDown, CornerDownRight, ListOrdered, ListPlus, Paperclip, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { money, tokens } from "@/lib/format";
import type { Category, ConfigOption, SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isDangerMode, ModeIcon, modeLabel, ProviderLogo } from "../icons";
import { Keys } from "../Keys";
import { SplitFlap } from "../SplitFlap";
import { CHIP_TRIGGER } from "./chip";
import { smooth } from "../motion";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";
import type { Attached } from "@/lib/attachments";
import { AttachBox, useAttachments } from "./Attachments";
import { MentionMenu, removeMention, useMention } from "./Mention";
import { useAutoGrow } from "./autoGrow";
import { isImeKey, isSendKey } from "@/lib/keys";
import { useStore, type Queued } from "@/state/store";
import { useT } from "@/i18n";

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
function ContextMeter({ info, pct, scope }: { info: SessionInfo; pct: number; scope: string }) {
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
          <span role="progressbar" aria-label={t("composer.contextUsage")} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1 w-10 overflow-hidden rounded-sm bg-muted">
            <motion.span className="block h-full bg-foreground" animate={{ width: `${pct}%` }} transition={smooth} />
          </span>
          {pct}%
        </button>
      </PopoverTrigger>
      <PopoverContent ref={menu.ref as React.Ref<HTMLDivElement>} style={menu.style} side="top" align="end" className={cn("z-[58] flex w-60 flex-col gap-2 p-3 text-xs", menu.moving && "opacity-0")}>
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
}: {
  agent: string;
  info: SessionInfo | null;
  onSet: (c: Category, v: string) => void;
  /** Text shown while the config options are not known yet */
  empty?: string;
  /** Per-pane name for the separation animation's origin (session or draft id) */
  scope: string;
}) {
  const t = useT();
  const raised = useLiquidActiveAnchors();
  const modelMenu = useLiquidMenu(`menu:${scope}:model`, `${scope}:model`);
  const effortMenu = useLiquidMenu(`menu:${scope}:effort`, `${scope}:effort`);
  const model = option(info, "model");
  const effort = option(info, "thought_level");
  const mode = currentMode(info);
  const modes = modeChoices(info);
  const nextMode = () => {
    if (modes.length === 0) return;
    const i = mode ? modes.indexOf(mode) : -1;
    onSet("mode", modes[(i + 1) % modes.length]);
  };
  const ctxPct = info?.context_used != null && info.context_size ? Math.round((info.context_used / info.context_size) * 100) : null;

  return (
    <div className="flex items-center gap-0.5 text-xs">
      {model && (
        <Select value={model.current ?? undefined} onValueChange={(v) => onSet("model", v)} onOpenChange={modelMenu.onOpenChange}>
          <SelectTrigger ref={liquidAnchor(`${scope}:model`)} aria-label="model" className={cn(CHIP_TRIGGER, "relative", raised.has(`${scope}:model`) && "z-[57]")}>
            <ProviderLogo agent={agent} className="size-3 text-muted-foreground" />
            <span>{model.choices.find((c) => c.value === model.current)?.name ?? model.current}</span>
            <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden />
          </SelectTrigger>
          <SelectContent ref={modelMenu.ref as React.Ref<HTMLDivElement>} style={modelMenu.style} position="popper" side="top" align="start" sideOffset={6} className={cn("z-[58]", modelMenu.moving && "opacity-0")}>
            {model.choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {effort && (
        <Select value={effort.current ?? undefined} onValueChange={(v) => onSet("thought_level", v)} onOpenChange={effortMenu.onOpenChange}>
          <SelectTrigger ref={liquidAnchor(`${scope}:effort`)} aria-label="effort" className={cn(CHIP_TRIGGER, "relative gap-1.5", raised.has(`${scope}:effort`) && "z-[57]")}>
            <span className="flex h-2.5 items-end gap-0.5" aria-hidden>
              {effort.choices.map((c, i) => (
                <span
                  key={c.value}
                  className={cn("block w-[3px] rounded-[1px]", i <= effort.choices.findIndex((x) => x.value === effort.current) ? "bg-foreground" : "bg-input")}
                  style={{ height: 2 + i * 2 }}
                />
              ))}
            </span>
            <span className="text-muted-foreground">{effort.current}</span>
          </SelectTrigger>
          <SelectContent ref={effortMenu.ref as React.Ref<HTMLDivElement>} style={effortMenu.style} position="popper" side="top" align="start" sideOffset={6} className={cn("z-[58]", effortMenu.moving && "opacity-0")}>
            {effort.choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {modes.length > 0 && (
        <button
          type="button"
          onClick={nextMode}
          aria-label={t("composer.switchMode", { mode: modeLabel(mode) })}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-md border px-1.5 hover:bg-accent",
            isDangerMode(mode) ? "border-error/40 text-error" : "border-border",
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
        </button>
      )}
      {empty && !model && !effort && modes.length === 0 && <span className="px-1.5 text-muted-foreground">{empty}</span>}
      <span className="grow" />
      {ctxPct != null && info && <ContextMeter info={info} pct={ctxPct} scope={scope} />}
    </div>
  );
}

/** Messages sent mid-turn. Sent in order from the front once the turn ends */
function QueueList({ items, busy, onRemove, onSendNow }: { items: Queued[]; busy: boolean; onRemove: (key: string) => void; onSendNow: () => void }) {
  const t = useT();
  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && (
        <motion.div key="queue" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={smooth} className="overflow-hidden">
          <div className="flex flex-col gap-0.5 pb-1">
            <div className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
              <ListOrdered className="size-3.5" aria-hidden />
              {busy ? t("composer.queueSendAfterTurn") : t("composer.queueUnsent")}
              <span className="font-mono tabular">{items.length}</span>
              {!busy && (
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
                  className="flex h-7 items-center gap-2 rounded-md bg-card pr-0.5 pl-2.5"
                >
                  <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 grow truncate">{q.text || q.attachments.map((a) => a.preview.name).join(" ")}</span>
                  {q.attachments.length > 0 && <Paperclip className="size-3 shrink-0 text-muted-foreground" aria-label={t("composer.attachmentsCount", { count: q.attachments.length })} />}
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
}) {
  const t = useT();
  const [text, setText] = useState("");
  // A chip added with @ and its "@path" in the text are kept together: removing either removes the other
  const att = useAttachments({ onMentionRemoved: (path) => setText((cur) => removeMention(cur, path)) });
  const sendKey = useStore((s) => s.settings.send_key ?? "enter");
  const textRef = useAutoGrow(text);
  const mention = useMention({ root, text, setText, textRef, boxRef: att.boxRef, scope, onPick: (h) => att.addMention(h.abs, h.path) });
  useEffect(() => {
    att.syncMentions(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const canSend = !disabled && (!!text.trim() || att.items.length > 0);
  // Mid-turn with empty text, the send button becomes stop
  const stopMode = busy && !text.trim() && att.items.length === 0 && !!onStop;
  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), att.items);
    setText("");
    att.clear();
  };
  const modes = modeChoices(info);
  const mode = currentMode(info);

  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 pb-3">
      <QueueList items={queue} busy={busy} onRemove={(k) => onUnqueue?.(k)} onSendNow={() => onSendQueued?.()} />
      <ControlRow scope={scope} agent={agent} info={info} onSet={onSet} />
      <MentionMenu m={mention} boxRef={att.boxRef} />
      <AttachBox att={att}>
        <textarea
          ref={textRef}
          aria-label={t("composer.message")}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            mention.syncCaret();
          }}
          onSelect={mention.syncCaret}
          onKeyDown={(e) => {
            // The @-mention list takes ↑↓, ⏎, ⇥ and esc while it is open
            if (mention.onKeyDown(e)) return;
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
          className="min-h-0 grow resize-none bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        {stopMode ? (
          <button
            type="button"
            aria-label={t("composer.stopEsc")}
            title={t("composer.stopEsc")}
            onClick={onStop}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Square className="size-3 fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            aria-label={busy ? t("composer.addToQueue") : t("composer.send")}
            title={busy ? t("composer.addToQueueHint") : undefined}
            disabled={!canSend}
            onClick={send}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground hover:bg-accent disabled:opacity-40"
          >
            {busy ? <ListPlus className="size-3.5" aria-hidden /> : <ArrowUp className="size-3.5" aria-hidden />}
          </button>
        )}
      </AttachBox>
    </div>
  );
}
