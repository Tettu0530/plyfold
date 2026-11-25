// @-mentions in the composer search the workspace or resolve a path directly. Picking a result
// inserts the mention and attaches the file as an ACP resource_link.
//   ↑↓ to choose, ⏎ or ⇥ to pick, esc to close. The list opens with the same liquid motion as other menus
import { FileText, Folder } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { isImeKey } from "@/lib/keys";
import type { FileHit } from "@/lib/types";
import { cn } from "@/lib/utils";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidMenu } from "../liquid/stage";

/** The "@query" being typed right before the caret, or null */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@("(?:[^"\r\n]|"")*"?|[^\s@"]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

// Quote paths with spaces or token delimiters. A doubled quote represents a literal quote.
const mentionToken = (path: string) => (/[\s@"]/.test(path) ? `@"${path.replaceAll('"', '""')}"` : `@${path}`);

function queryPath(query: string): string {
  return query.startsWith('"') ? query.slice(1).replace(/"$/, "").replaceAll('""', '"') : query;
}

const explicitPath = (query: string) => /^(?:["/\\]|[a-z]:|~[/\\]|\.{1,2}[/\\])/i.test(query);

/** Replace "@query" (from start to caret) with "@path" plus a space, and return the new text and the caret after the space */
export function insertMention(text: string, start: number, caret: number, path: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  // Add a space after the path unless one already follows
  const mention = mentionToken(path);
  const token = /^\s/.test(rest) ? mention : `${mention} `;
  const caretAt = start + token.length + (token.endsWith(" ") ? 0 : 1);
  return { text: text.slice(0, start) + token + rest, caret: caretAt };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "@path" as a whole token: at the start or after whitespace, and followed by whitespace or the end */
const mentionRe = (path: string, flags = "") => new RegExp(`(^|\\s)${escapeRe(mentionToken(path))}(?=\\s|$)`, flags);

/** Whether the text still mentions this path */
export function hasMention(text: string, path: string): boolean {
  return mentionRe(path).test(text);
}

/** Delete every "@path" token (and the space after it) from the text */
export function removeMention(text: string, path: string): string {
  const out = text
    .replace(mentionRe(path, "g"), "$1")
    .replace(/(^|\s) (?=\s|$)/g, "$1")
    .replace(/ {2,}/g, " ");
  // A mention at the very start leaves a leading space behind
  return /^\s/.test(text) ? out : out.replace(/^ +/, "");
}

interface Options {
  /** Directory to search (the session's worktree, or the repository for a new session) */
  root: string | null;
  text: string;
  setText: (t: string) => void;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Element the list rises from (the composer box) */
  boxRef: React.RefObject<HTMLElement | null>;
  /** Unique name for the liquid animation (per pane) */
  scope: string;
  onPick: (hit: FileHit) => void;
}

export function useMention({ root, text, setText, textRef, boxRef, scope, onPick }: Options) {
  const [caret, setCaret] = useState(0);
  const [result, setResult] = useState<{ root: string | null; query: string; hits: FileHit[] } | null>(null);
  const [active, setActive] = useState(0);
  // A token the user dismissed with esc stays closed until they start a different one
  const [dismissed, setDismissed] = useState<number | null>(null);
  const token = useMemo(() => mentionAt(text, caret), [text, caret]);
  const query = token?.query ?? "";
  const open = !!token && (!!root || explicitPath(query)) && token.start !== dismissed;
  const current = result?.query === query && result.root === root ? result : null;
  const hits = current?.hits ?? [];
  const loaded = !inTauri || current !== null;

  // The composer box is the origin of the liquid animation
  const anchor = `${scope}:mention`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  useEffect(() => {
    const el = boxRef.current;
    liquidAnchor(anchor)(el);
    return () => liquidAnchor(anchor)(null);
  }, [anchor, boxRef]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open !== wasOpen.current) menu.onOpenChange(open);
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Search while the token changes (a short delay so fast typing doesn't queue many searches)
  useEffect(() => {
    if (!open || !inTauri) return;
    let alive = true;
    const receive = (hits: FileHit[]) => {
      if (!alive) return;
      setResult({ root, query, hits });
      setActive(0);
    };
    const timer = setTimeout(() => {
      void api.searchFiles(root, queryPath(query), explicitPath(query)).then(receive, () => receive([]));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, root, query]);

  useEffect(() => {
    if (dismissed !== null && token?.start !== dismissed) setDismissed(null);
  }, [token, dismissed]);

  const pick = (hit: FileHit) => {
    if (!token) return;
    const path = hit.directory ? `${hit.path}/` : hit.path;
    const prefix = mentionToken(path);
    const next = hit.directory
      ? { text: text.slice(0, token.start) + prefix + text.slice(caret), caret: token.start + prefix.length - (prefix.startsWith('@"') ? 1 : 0) }
      : insertMention(text, token.start, caret, path);
    setText(next.text);
    if (!hit.directory) onPick(hit);
    // Put the caret after the inserted path once React has applied the new text
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
      setDismissed(token!.start);
      return true;
    }
    const accept = (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) || e.key === "Tab";
    if (hits.length === 0) {
      if (!loaded && explicitPath(query) && accept) {
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
      return true;
    }
    if (accept) {
      e.preventDefault();
      pick(hits[Math.min(active, hits.length - 1)]);
      return true;
    }
    return false;
  };

  /** Keep track of the caret (typing, clicking and arrow keys all move it) */
  const syncCaret = () => setCaret(textRef.current?.selectionStart ?? 0);

  return { open, hits, loaded, active, setActive, pick, onKeyDown, syncCaret, menu, dismiss: () => token && setDismissed(token.start) };
}

export type MentionState = ReturnType<typeof useMention>;

const separatorAt = (p: string) => Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
const dirOf = (p: string) => p.slice(0, Math.max(0, separatorAt(p)));
const nameOf = (p: string) => p.slice(separatorAt(p) + 1);

/** The list itself. Rendered next to the composer; anchored to the composer box */
export function MentionMenu({ m, boxRef }: { m: MentionState; boxRef: React.RefObject<HTMLElement | null> }) {
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
        className={cn("z-[58] flex w-[min(28rem,var(--radix-popper-anchor-width))] flex-col p-1.5", m.menu.moving && "opacity-0")}
      >
        <div className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">{t("composer.mentionLabel")}</div>
        <div ref={listRef} role="listbox" aria-label={t("composer.mentionLabel")} className="max-h-64 overflow-y-auto">
          {m.hits.map((h, i) => {
            const Icon = h.directory ? Folder : FileText;
            return (
              <button
                key={h.path}
                type="button"
                role="option"
                aria-selected={i === m.active}
                data-row={i}
                // mousedown keeps the focus in the composer
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => m.setActive(i)}
                onClick={() => m.pick(h)}
                className={cn("flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left", i === m.active && "bg-accent")}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="shrink-0 font-mono text-xs">{nameOf(h.path)}</span>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{dirOf(h.path)}</span>
              </button>
            );
          })}
          {m.hits.length === 0 && (
            <p className="m-0 px-1.5 py-1 text-xs text-muted-foreground">{t(m.loaded ? "composer.mentionEmpty" : "composer.mentionLoading")}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
