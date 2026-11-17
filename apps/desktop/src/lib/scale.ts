/** Steps for the display size (percent), as in Settings and ⌘= / ⌘- */
export const SCALES = [80, 90, 100, 110, 125, 150];

/** The next step up (d = 1) or down (d = -1) from the current size */
export function nextScale(current: number, d: 1 | -1 | number): number {
  if (d > 0) return SCALES.find((v) => v > current) ?? SCALES[SCALES.length - 1];
  return [...SCALES].reverse().find((v) => v < current) ?? SCALES[0];
}
