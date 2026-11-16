import { describe, expect, it } from "vitest";

import { lineDiff } from "./lineDiff";

describe("lineDiff", () => {
  it("marks changed lines and keeps nearby context", () => {
    const old = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
    const neu = ["a", "b", "c", "d", "e", "F", "g", "h", "i", "j"].join("\n") + "\n";
    const d = lineDiff(old, neu, 2);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["note:… 3 行", "ctx:d", "ctx:e", "del:f", "add:F", "ctx:g", "ctx:h", "note:… 2 行"]);
    const del = d.lines.find((l) => l.kind === "del")!;
    expect(del.old).toBe(6);
  });

  it("treats a new file as all added", () => {
    const d = lineDiff(null, "x\ny\n");
    expect(d.lines.map((l) => l.kind)).toEqual(["add", "add"]);
    expect(d.lines[1].new).toBe(2);
  });

  it("finds insertions in the middle", () => {
    const d = lineDiff("1\n2\n3\n", "1\n2\nnew\n3\n", 0);
    expect(d.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["note:… 2 行", "add:new", "note:… 1 行"]);
  });
});
