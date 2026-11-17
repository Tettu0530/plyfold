import { describe, expect, it } from "vitest";

import { insertMention, mentionAt } from "./Mention";

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
});
