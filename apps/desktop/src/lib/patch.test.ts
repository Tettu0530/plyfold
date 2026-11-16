import { describe, expect, it } from "vitest";

import { parsePatch, toSplit } from "./patch";

const PATCH = `diff --git a/src/a.rs b/src/a.rs
index 1111111..2222222 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,4 +10,5 @@ fn main() {
 keep
-old one
+new one
+new two
 tail
diff --git a/notes.md b/notes.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe("parsePatch", () => {
  const files = parsePatch(PATCH);
  it("splits files with status", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/a.rs", "modified"],
      ["notes.md", "added"],
      ["gone.txt", "deleted"],
    ]);
  });
  it("numbers lines", () => {
    const a = files[0].lines;
    expect(a[0].kind).toBe("hunk");
    expect(a[1]).toMatchObject({ kind: "ctx", old: 10, new: 10, text: "keep" });
    expect(a[2]).toMatchObject({ kind: "del", old: 11, new: null });
    expect(a[3]).toMatchObject({ kind: "add", old: null, new: 11 });
    expect(a[5]).toMatchObject({ kind: "ctx", old: 12, new: 13 });
    expect(files[1].lines.at(-1)?.kind).toBe("note");
  });
  it("pairs deletions with additions side by side", () => {
    const rows = toSplit(files[0].lines);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["@@ -10,4 +10,5 @@ fn main() {", null],
      ["keep", "keep"],
      ["old one", "new one"],
      [null, "new two"],
      ["tail", "tail"],
    ]);
  });
});
