// Slash commands in the composer: typing "/" at the very start of the message lists the commands the agent offers
// (ACP available_commands_update), filtered by what follows. Picking one replaces "/query" with "/name " and keeps the
// caret after it, ready for the command's input. After a whole command, the values its argument can take (from the
// hint's "[a|b]" alternatives, or the session's models for /model) are offered the same way; ⇥ takes one.
//   ↑↓ to choose, ⏎ or ⇥ to pick, esc to close. The list opens with the same liquid motion as other menus
import { useEffect, useMemo, useRef, useState } from "react";

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useT } from "@/i18n";
import { isImeKey } from "@/lib/keys";
import type { SlashCommand } from "@/lib/types";
import { cn } from "@/lib/utils";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidMenu } from "../liquid/stage";
import { Keys } from "../Keys";

/** The "/query" being typed, when it is the whole text before the caret, or null */
export function slashAt(text: string, caret: number): { query: string } | null {
  const m = /^\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? { query: m[1] } : null;
}

/** Commands matching the query: names starting with it first, then names containing it, then descriptions (from 3 characters, so one letter doesn't match half the list) */
export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const rank = (c: SlashCommand) => {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    if (q.length >= 3 && c.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return commands
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** The command at the start of the text, once its whole name is typed (followed by a space or the end) */
export function commandAt(text: string, commands: SlashCommand[]): SlashCommand | null {
  const m = /^\/(\S+)(?=\s|$)/.exec(text);
  return (m && commands.find((c) => c.name === m[1])) || null;
}

/**
 * The argument groups of a hint, at the top level: "[low|high] [--fix] <pr#>" → ["[low|high]", "[--fix]", "<pr#>"].
 * Brackets nest ("<low|ultracode [on|off]>" is one group)
 */
export function hintGroups(hint: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of hint.trim()) {
    if (ch === "[" || ch === "<" || ch === "(") depth++;
    if (ch === "]" || ch === ">" || ch === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The literal values a hint group offers: "[low|medium|high]" → low, medium, high; "<low|ultracode [on|off]>" → low,
 * ultracode; "[auto|<tokens>]" → auto. Placeholders ("<model>", "[name]") offer nothing
 */
export function groupChoices(group: string): string[] {
  const inner = group.replace(/^[[<(]/, "").replace(/[\]>)]$/, "");
  if (!inner.includes("|")) return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "[" || ch === "<" || ch === "(") depth++;
    if (ch === "]" || ch === ">" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim().split(/\s+/)[0]).filter((w) => /^[A-Za-z0-9][\w.:=-]*$/.test(w));
}

/** The argument being typed after a whole command: which one it is (from 0), what has been typed of it, and where it starts */
export function argAt(text: string, caret: number, commands: SlashCommand[]): { command: SlashCommand; index: number; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /^\/(\S+)\s+/.exec(before);
  if (!m) return null;
  const command = commands.find((c) => c.name === m[1]);
  if (!command) return null;
  const args = before.slice(m[0].length);
  if (args.includes("\n")) return null;
  const words = args.split(/\s+/);
  const query = words[words.length - 1];
  return { command, index: words.length - 1, query, start: caret - query.length };
}

/** Values to offer for an argument: from the hint's own alternatives, or the session's models for /model */
export function argChoices(command: SlashCommand, index: number, models: string[] = []): string[] {
  const groups = command.hint ? hintGroups(command.hint) : [];
  const fromHint = groups[index] ? groupChoices(groups[index]) : [];
  if (fromHint.length) return fromHint;
  return command.name === "model" && index === 0 ? models : [];
}

/** The hint to show after "/name " until something is typed (only right after the command) */
export function ghostHint(text: string, caret: number, commands: SlashCommand[]): string | null {
  const m = /^\/(\S+) $/.exec(text);
  if (!m || caret !== text.length) return null;
  return commands.find((c) => c.name === m[1])?.hint ?? null;
}

/** Replace "/query" (from the start to the caret) with "/name " and return the new text and caret */
export function insertCommand(text: string, caret: number, name: string): { text: string; caret: number } {
  const rest = text.slice(caret).replace(/^\S*/, "");
  const token = /^\s/.test(rest) ? `/${name}` : `/${name} `;
  return { text: token + rest, caret: token.length + (token.endsWith(" ") ? 0 : 1) };
}

interface Options {
  commands: SlashCommand[];
  /** The session's model values (offered after /model) */
  models?: string[];
  text: string;
  setText: (t: string) => void;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Element the list rises from (the composer box) */
  boxRef: React.RefObject<HTMLElement | null>;
  /** Unique name for the liquid animation (per pane) */
  scope: string;
}

export function useSlash({ commands, models = [], text, setText, textRef, boxRef, scope }: Options) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // A list closed with esc stays closed until the text no longer starts a command
  const [dismissed, setDismissed] = useState(false);
  const token = useMemo(() => slashAt(text, caret), [text, caret]);
  const hits = useMemo(() => (token ? matchCommands(commands, token.query) : []), [commands, token]);
  // After a whole command: the values its argument can take, filtered by what has been typed of it
  const arg = useMemo(() => (token ? null : argAt(text, caret, commands)), [token, text, caret, commands]);
  const values = useMemo(() => {
    if (!arg) return [];
    const q = arg.query.toLowerCase();
    return argChoices(arg.command, arg.index, models).filter((v) => v.toLowerCase().startsWith(q) && v !== arg.query);
  }, [arg, models]);
  const open = !dismissed && ((!!token && commands.length > 0) || values.length > 0);

  const anchor = `${scope}:slash`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  useEffect(() => {
    liquidAnchor(anchor)(boxRef.current);
    return () => liquidAnchor(anchor)(null);
  }, [anchor, boxRef]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open !== wasOpen.current) menu.onOpenChange(open);
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const key = token ? `c:${token.query}` : arg ? `a:${arg.command.name}:${arg.index}:${arg.query}` : "";
  useEffect(() => {
    if (!key) setDismissed(false);
    setActive(0);
  }, [key]);

  const place = (next: { text: string; caret: number }) => {
    setText(next.text);
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };
  const pick = (c: SlashCommand) => place(insertCommand(text, caret, c.name));
  /** Put a value in place of the argument being typed, followed by a space */
  const pickValue = (v: string) => {
    if (!arg) return;
    const rest = text.slice(caret).replace(/^\S*/, "");
    const head = text.slice(0, arg.start) + v;
    place({ text: head + (/^\s/.test(rest) ? rest : " " + rest), caret: head.length + 1 });
  };
  const count = token ? hits.length : values.length;

  /** Call first in the textarea's onKeyDown; returns true when the key was used by the list */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || isImeKey(e)) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
      return true;
    }
    if (count === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
      return true;
    }
    // A value is taken with ⇥ only, so ⏎ still sends a line like "/fast on" as typed
    if (((e.key === "Enter" && !e.shiftKey && !e.metaKey) || e.key === "Tab") && (token || e.key === "Tab")) {
      e.preventDefault();
      if (token) pick(hits[Math.min(active, count - 1)]);
      else pickValue(values[Math.min(active, count - 1)]);
      return true;
    }
    return false;
  };

  const syncCaret = () => setCaret(textRef.current?.selectionStart ?? 0);

  return {
    open,
    hits,
    /** Values for the argument being typed (empty while a command name is being typed) */
    values: token ? [] : values,
    /** The command whose argument is being completed */
    argOf: token ? null : (arg?.command ?? null),
    active,
    setActive,
    pick,
    pickValue,
    onKeyDown,
    syncCaret,
    caret,
    menu,
    dismiss: () => setDismissed(true),
  };
}

export type SlashState = ReturnType<typeof useSlash>;

/** The list itself. Rendered next to the composer; anchored to the composer box */
export function SlashMenu({ m, boxRef }: { m: SlashState; boxRef: React.RefObject<HTMLElement | null> }) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${m.active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [m.active]);
  return (
    <Popover open={m.open} onOpenChange={(o) => !o && m.dismiss()}>
      <PopoverAnchor virtualRef={boxRef as React.RefObject<HTMLElement>} />
      <PopoverContent
        ref={m.menu.ref as React.Ref<HTMLDivElement>}
        style={m.menu.style}
        side="top"
        align="start"
        sideOffset={6}
        // Keep typing in the composer while the list is open
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn("z-[58] flex w-[min(32rem,var(--radix-popper-anchor-width))] flex-col p-1.5", m.menu.moving && "opacity-0")}
      >
        <div className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">
          {m.argOf ? t("composer.slashArgLabel", { command: `/${m.argOf.name}` }) : t("composer.slashLabel")}
        </div>
        <div ref={listRef} role="listbox" aria-label={t("composer.slashLabel")} className="max-h-64 overflow-y-auto">
          {m.values.map((v, i) => (
            <button
              key={v}
              type="button"
              role="option"
              aria-selected={i === m.active}
              data-row={i}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => m.setActive(i)}
              onClick={() => m.pickValue(v)}
              className={cn("flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left", i === m.active && "bg-accent")}
            >
              <span className="font-mono text-xs">{v}</span>
              {i === m.active && <Keys keys={["tab"]} className="ml-auto" />}
            </button>
          ))}
          {!m.argOf &&
            m.hits.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === m.active}
                data-row={i}
                title={c.description}
                // mousedown keeps the focus in the composer
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => m.setActive(i)}
                onClick={() => m.pick(c)}
                className={cn("flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left", i === m.active && "bg-accent")}
              >
                <span className="shrink-0 font-mono text-xs text-command">/{c.name}</span>
                {c.hint && <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.hint}</span>}
                <span className="min-w-0 truncate text-xs text-muted-foreground">{c.description}</span>
              </button>
            ))}
          {!m.argOf && m.hits.length === 0 && <p className="m-0 px-1.5 py-1 text-xs text-muted-foreground">{t("composer.slashEmpty")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
