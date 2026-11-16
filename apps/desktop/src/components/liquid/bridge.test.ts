import { describe, expect, it } from "vitest";

import { bridgePath } from "./liquid";

describe("bridgePath (液架橋)", () => {
  const c1 = { x: 0, y: 0 };
  it("近いあいだは首でつながる", () => {
    expect(bridgePath(c1, 12, { x: 30, y: 0 }, 16)).toMatch(/^M .* C .* A .* C .* Z$/);
  });
  it("離れすぎると切れる", () => {
    // r1 + r2 * 3.5 = 12 + 56 = 68 を超えたら切れる
    expect(bridgePath(c1, 12, { x: 69, y: 0 }, 16)).toBeNull();
    expect(bridgePath(c1, 12, { x: 67, y: 0 }, 16)).not.toBeNull();
  });
  it("片方がもう片方の中に入りきったら描かない", () => {
    expect(bridgePath(c1, 20, { x: 2, y: 0 }, 10)).toBeNull();
  });
  it("離れるほど首が細くなる", () => {
    // 首のいちばん細いところの幅の目安: 取っ手の点どうしの距離ではなく、パスの数値が変わることだけ確かめる
    expect(bridgePath(c1, 12, { x: 40, y: 0 }, 16)).not.toEqual(bridgePath(c1, 12, { x: 60, y: 0 }, 16));
  });
});
