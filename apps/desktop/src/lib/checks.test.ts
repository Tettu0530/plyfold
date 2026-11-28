import { describe, expect, it } from "vitest";

import { allPassed, notRun, parseCommands, tail } from "./checks";
import type { VerifyResult } from "./types";

describe("tail", () => {
  it("keeps the end of long output", () => {
    expect(tail("abcdef", 3)).toEqual({ text: "def", cut: true });
    expect(tail("abc", 3)).toEqual({ text: "abc", cut: false });
  });
});

describe("parseCommands", () => {
  it("takes one command per line without blanks or repeats", () => {
    expect(parseCommands("npm test\n\n  npm run build  \nnpm test\n")).toEqual(["npm test", "npm run build"]);
  });
});

describe("allPassed", () => {
  const r = (status: VerifyResult["status"]): VerifyResult => ({ ...notRun("x"), status });
  it("is false for nothing, and for anything but passes", () => {
    expect(allPassed([])).toBe(false);
    expect(allPassed([r("passed"), r("passed")])).toBe(true);
    expect(allPassed([r("passed"), r("failed")])).toBe(false);
    expect(allPassed([r("passed"), r("not_run")])).toBe(false);
  });
});
