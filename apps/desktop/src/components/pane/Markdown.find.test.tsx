import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown find marks", () => {
  it("marks each occurrence in an answer, and the active one", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "one two one", needle: "one", activeOccurrence: 1 }));
    expect(html).toContain('data-find-hit="0"');
    expect(html).toContain('data-find-hit="1"');
    expect(html).toContain("bg-foreground/30");
  });

  it("leaves a message alone when there is no query", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "one two" }));
    expect(html).not.toContain("data-find-hit");
  });
});
