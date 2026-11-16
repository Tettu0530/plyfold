import { ArrowUp, ChevronsUpDown } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { money, tokens } from "@/lib/format";
import type { Category, ConfigOption, SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isDangerMode, ModeIcon, ProviderLogo } from "../icons";
import { Keys } from "../Keys";
import { SplitFlap } from "../SplitFlap";
import { CHIP_TRIGGER } from "./chip";
import { smooth } from "../motion";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";

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

/** コンテキストの使用率。押すと内訳を出す */
function ContextMeter({ info, pct, scope }: { info: SessionInfo; pct: number; scope: string }) {
  const anchor = `${scope}:ctx`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  const raised = useLiquidActiveAnchors().has(anchor);
  const t = info.total;
  const rows: [string, string][] = [
    ["入力（累計）", tokens(t.input + t.cached_read + t.cached_write)],
    ["うちキャッシュ", tokens(t.cached_read + t.cached_write)],
    ["出力（累計）", tokens(t.output)],
    ["費用（累計）", info.cost ? money(info.cost.amount, info.cost.currency) : "—"],
  ];
  return (
    <Popover onOpenChange={menu.onOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={liquidAnchor(anchor)}
          type="button"
          aria-label="コンテキストの詳細"
          className={cn(
            "relative flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-muted-foreground tabular hover:bg-accent hover:text-foreground data-[state=open]:bg-accent",
            raised && "z-[57]",
          )}
        >
          <span role="progressbar" aria-label="コンテキストの使用量" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1 w-10 overflow-hidden rounded-sm bg-muted">
            <motion.span className="block h-full bg-foreground" animate={{ width: `${pct}%` }} transition={smooth} />
          </span>
          {pct}%
        </button>
      </PopoverTrigger>
      <PopoverContent ref={menu.ref as React.Ref<HTMLDivElement>} side="top" align="end" className="z-[58] flex w-60 flex-col gap-2 p-3 text-xs">
        <div className="flex items-baseline justify-between">
          <span className="font-medium">コンテキスト</span>
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
            応答モデル <span className="font-mono text-foreground">{info.reported_model}</span>
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 入力欄のすぐ上: model / effort / mode と、コンテキストの使用量 */
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
  /** 設定項目がまだ分からないときに出す文 */
  empty?: string;
  /** 分離アニメーションの出発点の名前を、ペインごとに分けるため（セッションか下書きの id） */
  scope: string;
}) {
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
          <SelectContent ref={modelMenu.ref as React.Ref<HTMLDivElement>} className="z-[58]">
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
          <SelectContent ref={effortMenu.ref as React.Ref<HTMLDivElement>} className="z-[58]">
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
          aria-label="mode を切り替え（⇧⇥）"
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
                {m}
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

export function Composer({
  scope,
  agent,
  info,
  disabled,
  placeholder,
  onSend,
  onSet,
}: {
  scope: string;
  agent: string;
  info: SessionInfo | null;
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onSet: (c: Category, v: string) => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };
  const modes = modeChoices(info);
  const mode = currentMode(info);

  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 pb-3">
      <ControlRow scope={scope} agent={agent} info={info} onSet={onSet} />
      <div className="flex items-end gap-2 rounded-xl border border-input bg-card py-1.5 pr-1.5 pl-3 focus-within:border-ring">
        <textarea
          aria-label="指示"
          rows={2}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Tab" && e.shiftKey && modes.length > 0) {
              e.preventDefault();
              const i = mode ? modes.indexOf(mode) : -1;
              onSet("mode", modes[(i + 1) % modes.length]);
            }
          }}
          className="min-h-0 grow resize-none bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label="送る"
          disabled={disabled || !text.trim()}
          onClick={send}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground hover:bg-accent disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
