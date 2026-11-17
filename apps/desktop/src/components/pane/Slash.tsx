// Slash commands in the composer: typing "/" at the very start of the message lists the commands the agent offers
// (ACP available_commands_update), filtered by what follows. Picking one replaces "/query" with "/name " and keeps the
// caret after it, ready for the command's input.
//   ↑↓ to choose, ⏎ or ⇥ to pick, esc to close. The list opens with the same liquid motion as other menus
import { useEffect, useMemo, useRef, useState } from "react";

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useT } from "@/i18n";
import { isImeKey } from "@/lib/keys";
import type { SlashCommand } from "@/lib/types";
import { cn } from "@/lib/utils";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidMenu } from "../liquid/stage";

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

/** Replace "/query" (from the start to the caret) with "/name " and return the new text and caret */
export function insertCommand(text: string, caret: number, name: string): { text: string; caret: number } {
  const rest = text.slice(caret).replace(/^\S*/, "");
  const token = /^\s/.test(rest) ? `/${name}` : `/${name} `;
  return { text: token + rest, caret: token.length + (token.endsWith(" ") ? 0 : 1) };
}

interface Options {
  commands: SlashCommand[];
  text: string;
  setText: (t: string) => void;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Element the list rises from (the composer box) */
  boxRef: React.RefObject<HTMLElement | null>;
  /** Unique name for the liquid animation (per pane) */
  scope: string;
}

export function useSlash({ commands, text, setText, textRef, boxRef, scope }: Options) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // A list closed with esc stays closed until the text no longer starts a command
  const [dismissed, setDismissed] = useState(false);
  const token = useMemo(() => slashAt(text, caret), [text, caret]);
  const hits = useMemo(() => (token ? matchCommands(commands, token.query) : []), [commands, token]);
  const open = !!token && !dismissed && commands.length > 0;

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
  useEffect(() => {
    if (!token) setDismissed(false);
    setActive(0);
  }, [token?.query, token]);

  const pick = (c: SlashCommand) => {
    const next = insertCommand(text, caret, c.name);
    setText(next.text);
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  /** Call first in the textarea's onKeyDown; returns true when the key was used by the list */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || isImeKey(e)) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
      return true;
    }
    if (hits.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey && !e.metaKey) || e.key === "Tab") {
      e.preventDefault();
      pick(hits[Math.min(active, hits.length - 1)]);
      return true;
    }
    return false;
  };

  const syncCaret = () => setCaret(textRef.current?.selectionStart ?? 0);

  return { open, hits, active, setActive, pick, onKeyDown, syncCaret, menu, dismiss: () => setDismissed(true) };
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
        <div className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">{t("composer.slashLabel")}</div>
        <div ref={listRef} role="listbox" aria-label={t("composer.slashLabel")} className="max-h-64 overflow-y-auto">
          {m.hits.map((c, i) => (
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
              <span className="shrink-0 font-mono text-xs">/{c.name}</span>
              {c.hint && <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.hint}</span>}
              <span className="min-w-0 truncate text-xs text-muted-foreground">{c.description}</span>
            </button>
          ))}
          {m.hits.length === 0 && <p className="m-0 px-1.5 py-1 text-xs text-muted-foreground">{t("composer.slashEmpty")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
