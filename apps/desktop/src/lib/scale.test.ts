import { describe, expect, it } from "vitest";

import { nextScale } from "./scale";

describe("display size steps", () => {
  it("moves one step and stops at the ends", () => {
    expect(nextScale(100, 1)).toBe(110);
    expect(nextScale(100, -1)).toBe(90);
    expect(nextScale(150, 1)).toBe(150);
    expect(nextScale(80, -1)).toBe(80);
    // A size between steps goes to the nearest step in that direction
    expect(nextScale(105, 1)).toBe(110);
    expect(nextScale(105, -1)).toBe(100);
  });
});
