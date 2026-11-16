import { describe, expect, it } from "vitest";

import { BridgeSim, bridgeParams, contact, neckShape, rectGap, tailShape, type Rect } from "./bridge";

const row: Rect = { l: 8, t: 120, r: 232, b: 176 };
const at = (l: number, t: number, w = 150, h = 50): Rect => ({ l, t, r: l + w, b: t + h });

/** 一定の速さで離れていく実体に対して、sim を回す */
function run(sim: BridgeSim, gapAt: (t: number) => number, grownAt: (t: number) => number, secs: number) {
  const out: { t: number; mode: string; pull: number; half: number; tail: number }[] = [];
  const dt = 1 / 60;
  for (let t = 0; t <= secs; t += dt) {
    const raw = gapAt(t);
    const fr = sim.update(dt, raw, Math.max(0, raw - sim.pull), grownAt(t));
    out.push({ t, mode: sim.mode, ...fr });
  }
  return out;
}

describe("contact（向かい合う面の足）", () => {
  it("右へ離れた実体には、出発点の右の面から、実体の左の面へ付く", () => {
    const c = contact(row, at(400, 200))!;
    expect(c.a.n).toEqual({ x: 1, y: 0 });
    expect(c.s.n).toEqual({ x: -1, y: 0 });
    expect(c.a.p.x).toBeLessThan(row.r);
    expect(c.s.p.x).toBeGreaterThan(400);
    // 足は面の中に収まる
    expect(c.a.p.y - c.a.w).toBeGreaterThanOrEqual(row.t);
    expect(c.a.p.y + c.a.w).toBeLessThanOrEqual(row.b);
  });
  it("上に出たメニューには、上の面から下の面へ付く", () => {
    const chip = { l: 300, t: 400, r: 380, b: 424 };
    const c = contact(chip, { l: 296, t: 290, r: 456, b: 394 })!;
    expect(c.a.n).toEqual({ x: 0, y: -1 });
    expect(c.s.n).toEqual({ x: 0, y: 1 });
  });
  it("重なっているあいだは付けない（出発点の裏にいる）", () => {
    expect(contact(row, at(100, 130))).toBeNull();
    expect(rectGap(row, at(100, 130))).toBe(0);
  });
});

describe("形", () => {
  it("首は閉じた形と両脇の輪郭になる", () => {
    const n = neckShape(contact(row, at(400, 200))!, 4);
    expect(n.fill.startsWith("M ") && n.fill.endsWith("Z")).toBe(true);
    expect(n.outline.split("M").length - 1).toBe(2);
  });
  it("尾は、長さや幅が無ければ描かない", () => {
    const c = contact(row, at(400, 200))!;
    expect(tailShape(c.a, 8, 40)).not.toBeNull();
    expect(tailShape(c.a, 8, 0.2)).toBeNull();
    expect(tailShape(c.a, 0.1, 40)).toBeNull();
  });
});

describe("BridgeSim（開くとき）", () => {
  const p = bridgeParams(row);

  it("出発点が太いほど長く伸びる", () => {
    expect(bridgeParams({ l: 0, t: 0, r: 80, b: 24 }).breakGap).toBeLessThan(p.breakGap);
  });

  it("つながっているあいだは張力で引き留め、伸びきると切れて、ばねで前へ跳ねてから戻る", () => {
    const sim = new BridgeSim(true, p);
    let snapped = 0;
    sim.onSnap = () => snapped++;
    const f = run(sim, (t) => t * 1500, () => 0.3, 1.2);
    const before = f.filter((x) => x.mode === "attached");
    expect(Math.max(...before.map((x) => x.pull))).toBeCloseTo(p.pullCap, 5);
    // 伸びるほど細くなる
    expect(before[before.length - 1].half).toBeLessThan(before[1].half);
    expect(snapped).toBe(1);
    const after = f.filter((x) => x.mode === "snapped");
    // 張力を放すと、引き留めていた分を越えて前へ出る（負の引き留め）
    expect(Math.min(...after.map((x) => x.pull))).toBeLessThan(-1);
    expect(after[0].tail).toBeGreaterThan(0.9);
    expect(sim.done).toBe(true);
  });

  it("行き先が近くて伸びきらないときは、広がりきる直前にくびれて切れる", () => {
    const sim = new BridgeSim(true, p);
    const f = run(sim, () => 6, (t) => Math.min(1, t * 2.5), 1.2);
    expect(f.some((x) => x.mode === "pinching")).toBe(true);
    expect(f[f.length - 1].mode).toBe("snapped");
  });
});

describe("BridgeSim（閉じるとき）", () => {
  it("近づくまではつながらず、近づくと首が伸びて吸い込む", () => {
    const p = bridgeParams(row);
    const sim = new BridgeSim(false, p);
    const f = run(sim, (t) => Math.max(0, 400 - t * 1200), () => 0, 0.5);
    const first = f.findIndex((x) => x.mode === "forming");
    expect(first).toBeGreaterThan(0);
    expect(f[first - 1].half).toBe(0);
    expect(Math.max(...f.map((x) => x.pull))).toBeGreaterThan(0);
    expect(sim.done).toBe(false);
  });
});
