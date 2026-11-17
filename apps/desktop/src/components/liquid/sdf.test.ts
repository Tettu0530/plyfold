import { describe, expect, it } from "vitest";

import { Adhesion, boxOf, mergeAt, mergeWidth, PeelSpring, sdBox, separation, smin } from "./sdf";

describe("distance fields", () => {
  it("rounded box: negative inside, distance to edge outside", () => {
    const b = boxOf(0, 0, 100, 40, 8);
    expect(sdBox(50, 20, b)).toBeLessThan(0);
    expect(sdBox(110, 20, b)).toBeCloseTo(10, 5);
    // Corners are pulled in by the radius
    expect(sdBox(100, 40, b)).toBeCloseTo(Math.SQRT2 * 8 - 8, 5);
  });

  it("quadratic smin: connects when the gap is k/2 or less (matches measured GlassEffectContainer spacing)", () => {
    const k = 40;
    const joined = (gap: number) => smin(gap / 2, gap / 2, k).d <= 0;
    expect(joined(19.9)).toBe(true);
    expect(joined(20.1)).toBe(false);
    // Beyond k it's a plain min (edges don't pull together)
    expect(smin(5, 50, k).d).toBe(5);
  });

  it("mix factor: takes the nearer shape's color, half and half in the middle", () => {
    expect(smin(-10, 30, 40).m).toBeCloseTo(0, 1);
    expect(smin(30, -10, 40).m).toBeCloseTo(1, 1);
    expect(smin(5, 5, 40).m).toBeCloseTo(0.5, 5);
  });

  it("merge distance depends on anchor thickness and reaches 0 before full size", () => {
    expect(mergeWidth(20)).toBe(40);
    expect(mergeWidth(28)).toBeCloseTo(49.6, 5);
    expect(mergeWidth(200)).toBe(72);
    expect(mergeAt(60, 0.3)).toBe(60);
    expect(mergeAt(60, 0.9)).toBe(0);
  });
});

describe("overlap", () => {
  it("no merging when exactly overlapping (no bulge)", () => {
    expect(separation(0, 28)).toBe(0);
    expect(separation(14, 28)).toBeCloseTo(0.5, 5);
    expect(separation(40, 28)).toBe(1);
    // Merging two identical boxes with k bulges by k/4. Multiplying by separation keeps the original size
    const k = 48;
    expect(smin(-1, -1, k).d).toBeCloseTo(-1 - k / 4, 5);
    expect(smin(-1, -1, k * separation(0, 28)).d).toBe(-1);
  });
});

describe("Adhesion", () => {
  it("holds back while connected, then releases and springs forward when the neck breaks", () => {
    const a = new Adhesion(true);
    let snaps = 0;
    a.onSnap = () => snaps++;
    const k = 60;
    const pulls: number[] = [];
    for (let i = 0; i < 90; i++) pulls.push(a.update(1 / 60, i * 4, k));
    expect(snaps).toBe(1);
    expect(Math.max(...pulls)).toBeLessThanOrEqual(k * 0.8 + 1e-9);
    // After release it overshoots past 0, then returns
    expect(Math.min(...pulls)).toBeLessThan(-0.5);
    expect(Math.abs(pulls[pulls.length - 1])).toBeLessThan(1);
  });

  it("does not hold back when closing (starting disconnected)", () => {
    const a = new Adhesion(false);
    for (let i = 0; i < 30; i++) expect(a.update(1 / 60, 10, 60)).toBe(0);
  });
});

describe("soft-start spring (PeelSpring)", () => {
  it("starts slowly and settles the same way at the end", () => {
    const p = new PeelSpring(0.35, 0.3);
    let t = 0;
    while (t < 0.05) {
      p.step(1, 1 / 60);
      t += 1 / 60;
    }
    expect(p.x).toBeLessThan(0.15);
    for (let i = 0; i < 120; i++) p.step(1, 1 / 60);
    expect(p.settled(1)).toBe(true);
  });
});
