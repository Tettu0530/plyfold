import { ArrowUp, ChevronsUpDown } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { tokens } from "@/lib/format";
import type { Category, ConfigOption, SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isDangerMode, ModeIcon, ProviderLogo } from "../icons";
import { smooth } from "../motion";

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

/** 入力欄のすぐ上: model / effort / mode と、コンテキストの使用量 */
function ControlRow({
  agent,
  info,
  onSet,
}: {
  agent: string;
  info: SessionInfo | null;
  onSet: (c: Category, v: string) => void;
}) {
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
        <Select value={model.current ?? undefined} onValueChange={(v) => onSet("model", v)}>
          <SelectTrigger aria-label="model" className="h-6 gap-1 border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-accent [&>svg:last-child]:hidden">
            <ProviderLogo agent={agent} className="size-3 text-muted-foreground" />
            <span>{model.choices.find((c) => c.value === model.current)?.name ?? model.current}</span>
            <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden />
          </SelectTrigger>
          <SelectContent>
            {model.choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {effort && (
        <Select value={effort.current ?? undefined} onValueChange={(v) => onSet("thought_level", v)}>
          <SelectTrigger aria-label="effort" className="h-6 gap-1.5 border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-accent [&>svg:last-child]:hidden">
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
          <SelectContent>
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
          <motion.span key={mode ?? ""} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={smooth} className="flex items-center gap-1.5">
            <ModeIcon mode={mode} />
            {mode}
          </motion.span>
          <kbd className="font-mono text-xs text-muted-foreground">⇧⇥</kbd>
        </button>
      )}
      <span className="grow" />
      {ctxPct != null && (
        <span
          title={`コンテキスト ${tokens(info!.context_used!)} / ${tokens(info!.context_size!)}`}
          className="flex items-center gap-1.5 font-mono text-muted-foreground tabular"
        >
          <span role="progressbar" aria-label="コンテキストの使用量" aria-valuenow={ctxPct} aria-valuemin={0} aria-valuemax={100} className="h-1 w-10 overflow-hidden rounded-sm bg-muted">
            <motion.span className="block h-full bg-foreground" animate={{ width: `${ctxPct}%` }} transition={smooth} />
          </span>
          {ctxPct}%
        </span>
      )}
    </div>
  );
}

export function Composer({
  agent,
  info,
  disabled,
  placeholder,
  onSend,
  onSet,
}: {
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
      <ControlRow agent={agent} info={info} onSet={onSet} />
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
