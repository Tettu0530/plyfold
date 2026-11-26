import { describe, expect, it } from "vitest";

import { verdictChoice } from "./verdict";

const runs = [
  { id: "a", profile: "claude", agent: "claude" },
  { id: "b", profile: "codex-xerosharc", agent: "codex" },
  { id: "c", profile: "codex", agent: "codex" },
];

describe("verdictChoice", () => {
  it("reads the run named on the first line, in each language", () => {
    expect(verdictChoice("Take: claude\n\nIt passes every test.", runs)).toBe("a");
    expect(verdictChoice("採用: codex-xerosharc\n\n理由は…", runs)).toBe("b");
    expect(verdictChoice("采用：claude", runs)).toBe("a");
  });

  it("ignores markdown around the line and the name", () => {
    expect(verdictChoice("**Take: `claude`**", runs)).toBe("a");
    expect(verdictChoice("## 採用: 「codex」", runs)).toBe("c");
  });

  it("prefers the longer name that contains a shorter one", () => {
    expect(verdictChoice("Take: codex-xerosharc", runs)).toBe("b");
  });

  it("gives no choice when none or several are named", () => {
    expect(verdictChoice("None of them should be taken.", runs)).toBeNull();
    expect(verdictChoice("Take: gemini", runs)).toBeNull();
    expect(verdictChoice("Take: claude or codex", runs)).toBeNull();
  });
});
