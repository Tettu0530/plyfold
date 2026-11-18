import { describe, expect, it } from "vitest";

import { normalizeMath } from "./math";

describe("math delimiters", () => {
  it("turns \\( \\) and \\[ \\] into dollars", () => {
    expect(normalizeMath("Energy is \\(E = mc^2\\).")).toBe("Energy is $E = mc^2$.");
    expect(normalizeMath("Sum:\n\\[ \\sum_{i=1}^n i = \\frac{n(n+1)}{2} \\]\ndone")).toBe("Sum:\n\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\ndone");
  });

  it("leaves code alone", () => {
    const fenced = "```sh\necho \\(not math\\)\n```\nbut \\(x\\)";
    expect(normalizeMath(fenced)).toBe("```sh\necho \\(not math\\)\n```\nbut $x$");
    expect(normalizeMath("run `printf '\\(x\\)'` then \\(y\\)")).toBe("run `printf '\\(x\\)'` then $y$");
  });

  it("returns text without these delimiters unchanged", () => {
    const s = "Costs $5, and `$HOME` stays.";
    expect(normalizeMath(s)).toBe(s);
  });
});
