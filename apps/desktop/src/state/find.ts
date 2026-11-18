// Finding text in a conversation. User messages, answers and tool commands only (not thoughts, notices or tool output).
// Pure: the search card and the in-pane bar both use this, so a hit opened from ⌘K is the same match ⌘F lands on.

import { normalizeMath } from "@/lib/math";
import type { TranscriptItem } from "./transcript";

/** Shorter queries match too much of every conversation (a single letter, one kana) */
export const MIN_QUERY = 2;

/** Matches kept per message. A repeated token in a long answer does not produce an unbounded list */
const MAX_SPANS = 50;

export interface Span {
  start: number;
  end: number;
}

export interface FindMatch {
  itemIndex: number;
  /** Which match inside that message, in order */
  occurrence: number;
  start: number;
  end: number;
  /** The text that was searched (an answer is the math-normalised source, which is what Markdown renders) */
  text: string;
}

/** Case-insensitive spans. `toLowerCase` can change the length (ß); offsets would then mark the wrong characters, so that text is skipped */
export function spansIn(text: string, query: string): Span[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY || !text) return [];
  const folded = text.toLowerCase();
  if (folded.length !== text.length) return [];
  const spans: Span[] = [];
  let i = 0;
  while (spans.length < MAX_SPANS) {
    const at = folded.indexOf(needle, i);
    if (at < 0) break;
    spans.push({ start: at, end: at + needle.length });
    i = at + needle.length;
  }
  return spans;
}

function searchedText(item: TranscriptItem): string | null {
  if (item.kind === "user") return item.text || null;
  if (item.kind === "agent") return item.text ? normalizeMath(item.text) : null;
  if (item.kind === "tool") return item.command;
  return null;
}

export function findMatches(items: TranscriptItem[], query: string): FindMatch[] {
  if (query.trim().length < MIN_QUERY) return [];
  const out: FindMatch[] = [];
  items.forEach((item, itemIndex) => {
    const text = searchedText(item);
    if (!text) return;
    spansIn(text, query).forEach((s, occurrence) => out.push({ itemIndex, occurrence, ...s, text }));
  });
  return out;
}

/** A short line for the search card, collapsed to one line, with the match inside it */
export function excerptAround(text: string, start: number, end: number): string {
  const radius = 28;
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, end + radius);
  let slice = text.slice(a, b).replace(/\s+/g, " ").trim();
  if (a > 0) slice = `…${slice}`;
  if (b < text.length) slice = `${slice}…`;
  return slice;
}

export interface ItemHit {
  itemIndex: number;
  /** Index into `findMatches` for this transcript and query */
  matchIndex: number;
  excerpt: string;
}

/** The first match of each message, in order */
export function firstHitPerItem(items: TranscriptItem[], query: string): ItemHit[] {
  const matches = findMatches(items, query);
  const seen = new Set<number>();
  const out: ItemHit[] = [];
  matches.forEach((m, matchIndex) => {
    if (seen.has(m.itemIndex)) return;
    seen.add(m.itemIndex);
    out.push({ itemIndex: m.itemIndex, matchIndex, excerpt: excerptAround(m.text, m.start, m.end) });
  });
  return out;
}

export interface SearchableSession {
  id: string;
  title: string;
  /** Transcript already in memory. Null means `load` has to read the saved log */
  items: TranscriptItem[] | null;
}

export interface SessionHit extends ItemHit {
  sessionId: string;
  title: string;
}

/**
 * Search sessions in the order given (newest first) and stop once `limit` hits are collected, so older conversations
 * are not read when the list is already full. `load` failures are skipped. An empty list once `isCurrent` is false.
 */
export async function searchSessions(
  sessions: SearchableSession[],
  query: string,
  load: (id: string) => Promise<TranscriptItem[]>,
  isCurrent: () => boolean,
  limit = 8,
): Promise<SessionHit[]> {
  if (query.trim().length < MIN_QUERY) return [];
  const hits: SessionHit[] = [];
  for (let i = 0; i < sessions.length && hits.length < limit;) {
    if (!isCurrent()) return [];
    const batch = sessions.slice(i, i + 4);
    const loaded = await Promise.all(
      batch.map(async (s) => {
        if (s.items) return s.items;
        try {
          return await load(s.id);
        } catch {
          return [];
        }
      }),
    );
    if (!isCurrent()) return [];
    for (let j = 0; j < batch.length && hits.length < limit; j++) {
      for (const h of firstHitPerItem(loaded[j], query)) {
        if (hits.length >= limit) break;
        hits.push({ sessionId: batch[j].id, title: batch[j].title, ...h });
      }
    }
    i += batch.length;
  }
  return hits;
}

/** hast node, only the fields the marker walks */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
  position?: { start?: { offset?: number | null }; end?: { offset?: number | null } };
}

/**
 * Wrap matches in `<mark>` using the parser's source offsets, so the highlighted occurrence is the one `findMatches`
 * counted. A text node whose value is not the source slice (math that KaTeX already replaced) is left as it is.
 */
export function markHast(tree: HastNode, source: string, query: string, active: number | null): void {
  const spans = spansIn(source, query);
  if (spans.length === 0 || !tree.children) return;
  const visit = (node: HastNode) => {
    if (!node.children) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || !child.value) {
        visit(child);
        next.push(child);
        continue;
      }
      let start = child.position?.start?.offset;
      let end = child.position?.end?.offset;
      if (start == null || end == null) {
        next.push(child);
        continue;
      }
      // Inline code reports the position of the whole `code` node, backticks included, so the slice is "`merge()`"
      // while the text is "merge()". Shift to the value inside the fence. Other mismatches (KaTeX already replaced
      // the text) stay unmarked.
      if (source.slice(start, end) !== child.value) {
        const inside = node.tagName === "code" ? source.slice(start, end).indexOf(child.value) : -1;
        if (inside < 0) {
          next.push(child);
          continue;
        }
        start += inside;
        end = start + child.value.length;
      }
      const local = spans.map((s, index) => ({ ...s, index })).filter((s) => s.start < end && s.end > start);
      if (local.length === 0) {
        next.push(child);
        continue;
      }
      let at = start;
      for (const s of local) {
        const from = Math.max(s.start, start);
        const to = Math.min(s.end, end);
        if (from > at) next.push({ type: "text", value: source.slice(at, from) });
        next.push({
          type: "element",
          tagName: "mark",
          properties: { dataFindHit: String(s.index), ...(s.index === active ? { dataCurrent: "true" } : {}) },
          children: [{ type: "text", value: source.slice(from, to) }],
        });
        at = to;
      }
      if (at < end) next.push({ type: "text", value: source.slice(at, end) });
    }
    node.children = next;
  };
  visit(tree);
}
