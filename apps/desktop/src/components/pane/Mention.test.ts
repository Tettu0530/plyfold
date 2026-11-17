import { describe, expect, it } from "vitest";

import { hasMention, insertMention, mentionAt, removeMention } from "./Mention";

describe("mentions", () => {
  it("finds the @query right before the caret", () => {
    expect(mentionAt("fix @comp", 9)).toEqual({ start: 4, query: "comp" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    // Only at the start or after whitespace (not inside an email address)
    expect(mentionAt("me@example.com", 14)).toBeNull();
    // The caret has moved past the token
    expect(mentionAt("fix @comp now", 13)).toBeNull();
    // Japanese text before it still counts as a word boundary only with a space
    expect(mentionAt("これを @ma", 7)).toEqual({ start: 4, query: "ma" });
  });

  it("replaces the token with the path and moves the caret after it", () => {
    const r = insertMention("look at @comp please", 8, 13, "src/Composer.tsx");
    expect(r.text).toBe("look at @src/Composer.tsx please");
    expect(r.caret).toBe("look at @src/Composer.tsx ".length);
    const end = insertMention("look at @comp", 8, 13, "src/Composer.tsx");
    expect(end.text).toBe("look at @src/Composer.tsx ");
    expect(end.caret).toBe(end.text.length);
  });

  it("knows whether a path is still mentioned, as a whole token", () => {
    expect(hasMention("fix @src/a.ts now", "src/a.ts")).toBe(true);
    expect(hasMention("fix @src/a.ts", "src/a.ts")).toBe(true);
    // Partly deleted, or part of a longer path, no longer counts
    expect(hasMention("fix @src/a.t", "src/a.ts")).toBe(false);
    expect(hasMention("fix @src/a.tsx", "src/a.ts")).toBe(false);
    // Regex characters in paths are literal
    expect(hasMention("see @a+b(1).ts", "a+b(1).ts")).toBe(true);
  });

  it("removes every mention of a path and tidies the spaces", () => {
    expect(removeMention("look at @src/a.ts please", "src/a.ts")).toBe("look at please");
    expect(removeMention("@src/a.ts and @src/a.ts again", "src/a.ts")).toBe("and again");
    expect(removeMention("keep @src/a.tsx", "src/a.ts")).toBe("keep @src/a.tsx");
  });
});
