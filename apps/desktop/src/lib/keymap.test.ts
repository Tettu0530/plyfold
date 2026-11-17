import { describe, expect, it } from "vitest";

import { actionFor, bindingsOf, comboOf, comboProblem, DEFAULT_BINDINGS, keysOf, rebind } from "./keymap";

const ev = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("keymap", () => {
  it("reads combos from physical keys in a fixed modifier order", () => {
    expect(comboOf(ev("KeyK", { metaKey: true }))).toBe("cmd+k");
    expect(comboOf(ev("Backslash", { metaKey: true, shiftKey: true }))).toBe("cmd+shift+\\");
    // The ¥ key on Japanese keyboards is the same as backslash
    expect(comboOf(ev("IntlYen", { metaKey: true }))).toBe("cmd+\\");
    expect(comboOf(ev("KeyP", { shiftKey: true, altKey: true, metaKey: true, ctrlKey: true }))).toBe("cmd+ctrl+option+shift+p");
    expect(comboOf(ev("MetaLeft", { metaKey: true }))).toBeNull();
  });

  it("splits combos into keys, including a plus-like last key", () => {
    expect(keysOf("cmd+shift+\\")).toEqual(["cmd", "shift", "\\"]);
    expect(keysOf("cmd+=")).toEqual(["cmd", "="]);
    expect(keysOf("")).toEqual([]);
  });

  it("applies overrides and ignores broken ones", () => {
    const b = bindingsOf({ search: "cmd+p", stop: "", nope: "cmd+j", settings: "shift+cmd+x", newSession: "cmd+bogus" });
    expect(b.search).toBe("cmd+p");
    expect(b.stop).toBe("");
    expect(b.settings).toBe(DEFAULT_BINDINGS.settings);
    expect(b.newSession).toBe(DEFAULT_BINDINGS.newSession);
    expect(actionFor(ev("KeyP", { metaKey: true }), b)).toBe("search");
    expect(actionFor(ev("KeyK", { metaKey: true }), b)).toBeNull();
  });

  it("rejects combos that typing or macOS would hit", () => {
    expect(comboProblem("k")).toBe("needsModifier");
    expect(comboProblem("shift+k")).toBe("needsModifier");
    expect(comboProblem("f5")).toBeNull();
    expect(comboProblem("cmd+c")).toBe("reserved");
    expect(comboProblem("cmd+3")).toBe("reserved");
    expect(comboProblem("ctrl+k")).toBeNull();
  });

  it("moves a combo away from the action that had it and keeps only real changes", () => {
    const r = rebind({}, "evenLayout", "cmd+k");
    expect(r.moved).toBe("search");
    expect(r.overrides).toEqual({ evenLayout: "cmd+k", search: "" });
    // Setting an action back to its default drops the override
    expect(rebind({ search: "cmd+p" }, "search", "cmd+k").overrides).toEqual({});
  });
});
