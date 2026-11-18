import { describe, expect, it } from "vitest";

import { excerptAround, findMatches, firstHitPerItem, markHast, searchSessions, spansIn, type SearchableSession } from "./find";
import type { ToolCall, TranscriptItem } from "./transcript";

const tool = (command: string | null, result = ""): ToolCall => ({
  kind: "tool",
  id: "t",
  title: command ?? "read",
  toolKind: "execute",
  status: "completed",
  diffs: [],
  command,
  path: null,
  note: null,
  stream: "",
  result,
  exitCode: 0,
  toolName: null,
  background: false,
  refs: [],
  startedAt: null,
  endedAt: null,
});

const items: TranscriptItem[] = [
  { kind: "user", text: "Please Remember this" },
  { kind: "agent", text: "I will remember this." },
  { kind: "thought", text: "remember hidden" },
  tool("echo remember", "remember in the output"),
  { kind: "notice", text: "remember the notice" },
];

describe("spansIn", () => {
  it("is case-insensitive and does not overlap", () => {
    expect(spansIn("Aaa aaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
  });

  it("ignores a query shorter than two characters", () => {
    expect(spansIn("alpha", "a")).toEqual([]);
    expect(spansIn("alpha", "  ")).toEqual([]);
  });

  it("skips text whose lowercase form changes length", () => {
    expect(spansIn("straße", "ss")).toEqual([]);
  });
});

describe("findMatches", () => {
  it("finds user text, answers and commands, and not thoughts, notices or tool output", () => {
    const found = findMatches(items, "remember");
    expect(found.map((m) => m.itemIndex)).toEqual([0, 1, 3]);
    expect(found[0]).toMatchObject({ occurrence: 0, start: 7, end: 15 });
  });

  it("keeps one row per message for the search card, pointing at that match", () => {
    const hits = firstHitPerItem(
      [
        { kind: "user", text: "alpha alpha" },
        { kind: "agent", text: "beta" },
      ],
      "alpha",
    );
    expect(hits).toEqual([{ itemIndex: 0, matchIndex: 0, excerpt: "alpha alpha" }]);
    expect(findMatches([{ kind: "user", text: "alpha alpha" }], "alpha")).toHaveLength(2);
  });

  it("clips the excerpt around the match", () => {
    const text = `${"x".repeat(40)}remember${"y".repeat(40)}`;
    const [m] = findMatches([{ kind: "user", text }], "remember");
    expect(excerptAround(text, m.start, m.end)).toBe(`…${"x".repeat(28)}remember${"y".repeat(28)}…`);
  });
});

describe("searchSessions", () => {
  const session = (id: string, text: string | null): SearchableSession => ({
    id,
    title: id,
    items: text == null ? null : [{ kind: "user", text }],
  });

  it("keeps caller order, caps the rows, and does not load a later batch", async () => {
    const loaded: string[] = [];
    const hits = await searchSessions(
      [session("a", null), session("b", null), session("c", null), session("d", null), session("e", null)],
      "hit",
      async (id) => {
        loaded.push(id);
        return [{ kind: "user", text: id === "a" ? "nope" : `hit ${id}` }];
      },
      () => true,
      2,
    );
    expect(hits.map((h) => h.sessionId)).toEqual(["b", "c"]);
    // Reads four at a time, and stops before the next four once the list is full
    expect(loaded).toEqual(["a", "b", "c", "d"]);
    expect(hits[0]).toMatchObject({ itemIndex: 0, matchIndex: 0, excerpt: "hit b" });
  });

  it("drops a log that fails to load and returns nothing once the query is stale", async () => {
    const hits = await searchSessions(
      [session("a", null), session("b", "hit here")],
      "hit",
      async () => Promise.reject(new Error("gone")),
      () => true,
      8,
    );
    expect(hits.map((h) => h.sessionId)).toEqual(["b"]);

    let current = true;
    const stale = await searchSessions(
      [session("a", null)],
      "hit",
      async () => {
        current = false;
        return [{ kind: "user", text: "hit" }];
      },
      () => current,
    );
    expect(stale).toEqual([]);
  });
});

describe("markHast", () => {
  it("wraps the source occurrence and marks the active one", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: "one two one", position: { start: { offset: 0 }, end: { offset: 11 } } }],
        },
      ],
    };
    markHast(tree, "one two one", "one", 1);
    const p = tree.children[0] as { children?: { type: string; value?: string; properties?: Record<string, unknown> }[] };
    expect(p.children?.map((n) => (n.type === "text" ? n.value : n.properties))).toEqual([
      { dataFindHit: "0" },
      " two ",
      { dataFindHit: "1", dataCurrent: "true" },
    ]);
  });

  it("marks a match inside inline code whose position includes the backticks", () => {
    const source = "see `merge()`";
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "code",
          children: [{ type: "text", value: "merge()", position: { start: { offset: 4 }, end: { offset: 13 } } }],
        },
      ],
    };
    markHast(tree, source, "merge", 0);
    const code = tree.children[0] as { children?: { type: string; value?: string; properties?: Record<string, unknown> }[] };
    expect(code.children?.map((n) => (n.type === "text" ? n.value : n.properties))).toEqual([{ dataFindHit: "0", dataCurrent: "true" }, "()"]);
  });

  it("leaves a text node whose value is not the source slice", () => {
    const tree = {
      type: "root",
      children: [{ type: "text", value: "replaced", position: { start: { offset: 0 }, end: { offset: 3 } } }],
    };
    markHast(tree, "one", "on", 0);
    expect(tree.children).toEqual([{ type: "text", value: "replaced", position: { start: { offset: 0 }, end: { offset: 3 } } }]);
  });
});
