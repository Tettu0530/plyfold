import { describe, expect, it } from "vitest";

import { project, rubberBand, SMOOTH, SNAPPY, springConstants, springPosition, springToCss } from "./motion";

describe("Apple springs", () => {
  it("matches the SwiftUI conversion formulas", () => {
    const k = springConstants({ duration: 0.5, bounce: 0.3 });
    expect(k.stiffness).toBeCloseTo(((2 * Math.PI) / 0.5) ** 2, 6); // ≈ 157.9
    expect(k.damping).toBeCloseTo((4 * Math.PI * 0.7) / 0.5, 6); // ≈ 17.6
    // overdamped
    expect(springConstants({ duration: 0.5, bounce: -0.5 }).damping).toBeCloseTo((4 * Math.PI) / 0.25, 6);
  });

  it("bounce 0 does not overshoot, bounce 0.3 does", () => {
    const peak = (p: typeof SMOOTH) => {
      const k = springConstants(p);
      let m = 0;
      for (let t = 0; t < 2; t += 0.002) m = Math.max(m, springPosition(k, t));
      return m;
    };
    expect(peak(SMOOTH)).toBeLessThanOrEqual(1.0000001);
    // bounce 0.3 is damping ratio 0.7. Theoretical overshoot is e^(−πζ/√(1−ζ²)) ≈ 4.6%
    const zeta = 0.7;
    expect(peak(SNAPPY)).toBeCloseTo(1 + Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)), 3);
  });

  it("the CSS curve starts at 0 and ends at 1", () => {
    const { easing, ms } = springToCss(SNAPPY);
    expect(easing.startsWith("linear(0.0000")).toBe(true);
    expect(easing.endsWith(", 1)")).toBe(true);
    expect(ms).toBeGreaterThan(200);
    expect(ms).toBeLessThan(1500);
  });

  it("inertia projection and rubber banding", () => {
    expect(project(0, 1000)).toBeCloseTo(499, 0); // 1000pt/s -> about 499pt ahead
    expect(project(100, 0)).toBe(100);
    const r = rubberBand(1000, 400);
    expect(r).toBeLessThan(400);
    expect(r).toBeGreaterThan(0);
    expect(rubberBand(-50, 400)).toBeLessThan(0);
  });
});
