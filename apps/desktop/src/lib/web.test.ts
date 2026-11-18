import { describe, expect, it } from "vitest";

import { fetchedUrl, isWebSearch, parseSearchHits } from "./web";

describe("web tool results", () => {
  it("reads search hits", () => {
    const hits = parseSearchHits(
      "Plyfold on GitHub (https://github.com/Tettu0530/plyfold)\nRust (programming language) (https://en.wikipedia.org/wiki/Rust_(programming_language))\n",
    );
    expect(hits).toEqual([
      { title: "Plyfold on GitHub", url: "https://github.com/Tettu0530/plyfold", host: "github.com" },
      { title: "Rust (programming language)", url: "https://en.wikipedia.org/wiki/Rust_(programming_language)", host: "en.wikipedia.org" },
    ]);
  });

  it("leaves other text alone", () => {
    expect(parseSearchHits("No results found.")).toBeNull();
    expect(parseSearchHits("")).toBeNull();
    expect(parseSearchHits("A (https://a.example)\nnot a hit")).toBeNull();
  });

  it("finds the fetched page and tells searches apart", () => {
    expect(fetchedUrl("Fetch https://example.com/docs (from char 100)")).toBe("https://example.com/docs");
    expect(fetchedUrl('Search "x"')).toBeNull();
    expect(isWebSearch('Search "rust async"', "fetch")).toBe(true);
    expect(isWebSearch("Fetch https://a.example", "fetch")).toBe(false);
  });
});
