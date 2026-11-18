import { describe, expect, it } from "vitest";

import { argAt, argChoices, commandAt, ghostHint, groupChoices, hintGroups, insertCommand, matchCommands, slashAt } from "./Slash";

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

describe("command arguments", () => {
  const cmds = [
    { name: "fast", description: "", hint: "[on|off]" },
    { name: "effort", description: "", hint: "<low|medium|high|xhigh|max|auto|ultracode [on|off]>" },
    { name: "code-review", description: "", hint: "[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]" },
    { name: "autocompact", description: "", hint: "[auto|<tokens>]" },
    { name: "model", description: "", hint: "<model>" },
    { name: "init", description: "", hint: null },
  ];

  it("recognises a whole command at the start", () => {
    expect(commandAt("/fast on", cmds)?.name).toBe("fast");
    expect(commandAt("/fast", cmds)?.name).toBe("fast");
    expect(commandAt("/fas", cmds)).toBeNull();
    expect(commandAt("/nope x", cmds)).toBeNull();
    expect(commandAt("say /fast", cmds)).toBeNull();
  });

  it("reads the values a hint offers", () => {
    expect(hintGroups("[low|high] [--fix] <pr#>")).toEqual(["[low|high]", "[--fix]", "<pr#>"]);
    expect(hintGroups("<low|ultracode [on|off]>")).toEqual(["<low|ultracode [on|off]>"]);
    expect(groupChoices("[on|off]")).toEqual(["on", "off"]);
    expect(groupChoices("<low|medium|high|xhigh|max|auto|ultracode [on|off]>")).toEqual(["low", "medium", "high", "xhigh", "max", "auto", "ultracode"]);
    expect(groupChoices("[auto|<tokens>]")).toEqual(["auto"]);
    expect(groupChoices("<model>")).toEqual([]);
    expect(groupChoices("[--fix]")).toEqual([]);
  });

  it("finds the argument being typed and its values", () => {
    const a = argAt("/code-review hi", 15, cmds)!;
    expect([a.command.name, a.index, a.query, a.start]).toEqual(["code-review", 0, "hi", 13]);
    expect(argChoices(a.command, a.index)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(argAt("/code-review high --f", 21, cmds)!.index).toBe(1);
    expect(argAt("/fast", 5, cmds)).toBeNull();
    expect(argChoices(cmds[4], 0, ["opus", "sonnet"])).toEqual(["opus", "sonnet"]);
    expect(argChoices(cmds[5], 0)).toEqual([]);
  });

  it("shows the hint right after the command only", () => {
    expect(ghostHint("/model ", 7, cmds)).toBe("<model>");
    expect(ghostHint("/model o", 8, cmds)).toBeNull();
    expect(ghostHint("/init ", 6, cmds)).toBeNull();
    expect(ghostHint("/model ", 3, cmds)).toBeNull();
  });
});
