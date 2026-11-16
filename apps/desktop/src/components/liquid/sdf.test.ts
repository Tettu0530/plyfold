import { describe, expect, it } from "vitest";

import { Adhesion, boxOf, mergeAt, mergeWidth, PeelSpring, sdBox, smin } from "./sdf";

describe("距離場", () => {
  it("角丸の箱: 中は負、外は縁までの距離", () => {
    const b = boxOf(0, 0, 100, 40, 8);
    expect(sdBox(50, 20, b)).toBeLessThan(0);
    expect(sdBox(110, 20, b)).toBeCloseTo(10, 5);
    // 角は丸みのぶん内側に入る
    expect(sdBox(100, 40, b)).toBeCloseTo(Math.SQRT2 * 8 - 8, 5);
  });

  it("2 次の smin: すきまが k/2 以下でつながる（GlassEffectContainer の spacing の実測と同じ）", () => {
    const k = 40;
    const joined = (gap: number) => smin(gap / 2, gap / 2, k).d <= 0;
    expect(joined(19.9)).toBe(true);
    expect(joined(20.1)).toBe(false);
    // k より離れれば、ただの min（縁も寄らない）
    expect(smin(5, 50, k).d).toBe(5);
  });

  it("混ざり具合: 近い方の形の色になり、真ん中で半分ずつ", () => {
    expect(smin(-10, 30, 40).m).toBeCloseTo(0, 1);
    expect(smin(30, -10, 40).m).toBeCloseTo(1, 1);
    expect(smin(5, 5, 40).m).toBeCloseTo(0.5, 5);
  });

  it("つながる幅は出発点の太さで決まり、広がりきる前に 0 になる", () => {
    expect(mergeWidth(20)).toBe(40);
    expect(mergeWidth(28)).toBeCloseTo(49.6, 5);
    expect(mergeWidth(200)).toBe(72);
    expect(mergeAt(60, 0.3)).toBe(60);
    expect(mergeAt(60, 0.9)).toBe(0);
  });
});

describe("粘り（Adhesion）", () => {
  it("つながっているあいだは引き留め、首が切れたら放して前へ跳ねる", () => {
    const a = new Adhesion(true);
    let snaps = 0;
    a.onSnap = () => snaps++;
    const k = 60;
    const pulls: number[] = [];
    for (let i = 0; i < 90; i++) pulls.push(a.update(1 / 60, i * 4, k));
    expect(snaps).toBe(1);
    expect(Math.max(...pulls)).toBeLessThanOrEqual(k * 0.8 + 1e-9);
    // 放したあとは 0 を越えて前へ出てから戻る
    expect(Math.min(...pulls)).toBeLessThan(-0.5);
    expect(Math.abs(pulls[pulls.length - 1])).toBeLessThan(1);
  });

  it("閉じるとき（つながっていない状態から）は引き留めない", () => {
    const a = new Adhesion(false);
    for (let i = 0; i < 30; i++) expect(a.update(1 / 60, 10, 60)).toBe(0);
  });
});

describe("出だしの柔らかいばね（PeelSpring）", () => {
  it("最初はゆっくり、最後は同じように着いて止まる", () => {
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
