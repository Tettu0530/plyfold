import { describe, expect, it } from "vitest";

import { canInsert, fillPrompt, matchesQuery } from "./prompts";

describe("saved messages", () => {
  it("fills the repository and the branch and leaves other braces", () => {
    expect(fillPrompt("in {repo} on {branch}, keep {file}", { repo: "/work/app", branch: "main" })).toBe("in /work/app on main, keep {file}");
    expect(fillPrompt("{branch}", { repo: "/work/app", branch: "" })).toBe("");
  });

  it("inserts a repository message only into that repository", () => {
    expect(canInsert({ repo: null }, "/work/app")).toBe(true);
    expect(canInsert({ repo: null }, null)).toBe(true);
    expect(canInsert({ repo: "/work/app" }, "/work/app")).toBe(true);
    expect(canInsert({ repo: "/work/app" }, "/work/other")).toBe(false);
    expect(canInsert({ repo: "/work/app" }, null)).toBe(false);
  });

  it("matches the name or the body", () => {
    const prompt = { name: "Fix tests", body: "Run the suite" };
    expect(matchesQuery(prompt, "")).toBe(true);
    expect(matchesQuery(prompt, "  FIX ")).toBe(true);
    expect(matchesQuery(prompt, "suite")).toBe(true);
    expect(matchesQuery(prompt, "deploy")).toBe(false);
  });
});
