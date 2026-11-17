import { describe, expect, it } from "vitest";

import { insertCommand, matchCommands, slashAt } from "./Slash";

const cmds = [
  { name: "compact", description: "Clear history but keep a summary", hint: "instructions" },
  { name: "review", description: "Review the current changes", hint: null },
  { name: "init", description: "Write a CLAUDE.md for the project", hint: null },
];

describe("slash commands", () => {
  it("only triggers at the very start of the message", () => {
    expect(slashAt("/co", 3)).toEqual({ query: "co" });
    expect(slashAt("/", 1)).toEqual({ query: "" });
    expect(slashAt(" /co", 4)).toBeNull();
    expect(slashAt("see /co", 7)).toBeNull();
    expect(slashAt("/compact now", 12)).toBeNull();
    expect(slashAt("src/a", 5)).toBeNull();
  });

  it("ranks name prefixes, then name matches, then descriptions", () => {
    expect(matchCommands(cmds, "").map((c) => c.name)).toEqual(["compact", "review", "init"]);
    expect(matchCommands(cmds, "i").map((c) => c.name)).toEqual(["init", "review"]);
    expect(matchCommands(cmds, "changes").map((c) => c.name)).toEqual(["review"]);
    expect(matchCommands(cmds, "zzz")).toEqual([]);
  });

  it("replaces the typed part with the command and a space", () => {
    expect(insertCommand("/co", 3, "compact")).toEqual({ text: "/compact ", caret: 9 });
    expect(insertCommand("/co keep tests", 3, "compact")).toEqual({ text: "/compact keep tests", caret: 9 });
    expect(insertCommand("/comXYZ", 4, "compact")).toEqual({ text: "/compact ", caret: 9 });
  });
});
