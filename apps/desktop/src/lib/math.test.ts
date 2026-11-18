import { describe, expect, it } from "vitest";

import { normalizeMath } from "./math";

describe("math delimiters", () => {
  it("turns \\( \\) and \\[ \\] into dollars", () => {
    expect(normalizeMath("Energy is \\(E = mc^2\\).")).toBe("Energy is $E = mc^2$.");
    expect(normalizeMath("Sum:\n\\[ \\sum_{i=1}^n i = \\frac{n(n+1)}{2} \\]\ndone")).toBe("Sum:\n\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\ndone");
  });

  it("puts $$ on lines of their own, also when it runs into the formula across lines", () => {
    expect(normalizeMath("see\n\n$$e^z=\\sum z^n$$\n\nok")).toBe("see\n\n\n$$\ne^z=\\sum z^n\n$$\n\n\nok");
    expect(normalizeMath("$$a=b\n+c\n=d$$")).toBe("\n$$\na=b\n+c\n=d\n$$\n");
    // Already in that form: still a block
    expect(normalizeMath("$$\nx\n$$")).toBe("\n$$\nx\n$$\n");
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
