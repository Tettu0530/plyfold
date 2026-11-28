import { describe, expect, it } from "vitest";

import { isDangerMode, modeLabel } from "./icons";

describe("modeLabel", () => {
  it("names Gemini CLI's and Antigravity's modes like the equivalent ones of the other agents", () => {
    expect(modeLabel("yolo")).toBe(modeLabel("bypassPermissions"));
    expect(modeLabel("auto_edit")).toBe(modeLabel("acceptEdits"));
    expect(modeLabel("autoEdit")).toBe(modeLabel("acceptEdits"));
    expect(isDangerMode("yolo")).toBe(true);
    expect(isDangerMode("auto_edit")).toBe(false);
  });
  it("makes an unknown id readable instead of showing it raw", () => {
    expect(modeLabel("some_new-mode")).toBe("Some new mode");
    expect(modeLabel("fooBar")).toBe("Foo bar");
    expect(modeLabel(null)).toBe("");
  });
});
