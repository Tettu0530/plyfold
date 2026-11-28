import { describe, expect, it } from "vitest";

import {
  evenSizes,
  freeSlot,
  leaf,
  leaves,
  moveSlot,
  pathOf,
  preset,
  presetOf,
  removeSlot,
  setSizes,
  splitAt,
  swapSlots,
  validLayout,
  type LayoutNode,
} from "./layout";

const sizesOf = (n: LayoutNode) => (n.kind === "split" ? n.sizes.map((s) => Math.round(s * 100) / 100) : []);

describe("layout tree", () => {
  it("builds and recognises the presets", () => {
    expect(leaves(preset(4))).toEqual([0, 1, 2, 3]);
    expect(presetOf(preset(1))).toBe(1);
    expect(presetOf(preset(2))).toBe(2);
    expect(presetOf(preset(4))).toBe(4);
    expect(presetOf(splitAt(preset(2), 1, "bottom", 2))).toBeNull();
  });

  it("splits next to a pane, as a sibling on the same axis or nested otherwise", () => {
    // Right of 0 in a row: becomes a third column, taking half of 0's width
    const row = splitAt(preset(2), 0, "right", 2);
    expect(leaves(row)).toEqual([0, 2, 1]);
    expect(sizesOf(row)).toEqual([0.25, 0.25, 0.5]);
    // Below 1 in a row: 1 turns into a column of [1, 2]
    const nested = splitAt(preset(2), 1, "bottom", 2);
    expect(nested.kind === "split" && nested.children[1].kind === "split" && nested.children[1].axis).toBe("column");
    expect(leaves(nested)).toEqual([0, 1, 2]);
    // Left of a single pane
    expect(leaves(splitAt(leaf(0), 0, "left", 1))).toEqual([1, 0]);
  });

  it("removes a pane, gives its space away and collapses splits left with one child", () => {
    const three = splitAt(preset(2), 0, "right", 2);
    const two = removeSlot(three, 2)!;
    expect(leaves(two)).toEqual([0, 1]);
    // The closed pane's space goes back to the one before it: 0 and 1 are as they were before 2 was opened
    expect(sizesOf(two)).toEqual([0.5, 0.5]);
    expect(removeSlot(leaf(0), 0)).toBeNull();
    // Removing one of a nested column leaves a flat row
    const nested = splitAt(preset(2), 1, "bottom", 2);
    const flat = removeSlot(nested, 2)!;
    expect(flat.kind === "split" && flat.children.every((c) => c.kind === "leaf")).toBe(true);
  });

  it("returns the space to the neighbour it came from, not to everyone", () => {
    // Two panes, a third opened at the right end and closed again: the first keeps its size (it was not asked to give any)
    const two = setSizes(preset(2), [], [0.6, 0.4]);
    const three = splitAt(two, 1, "right", 2);
    expect(sizesOf(three)).toEqual([0.6, 0.2, 0.2]);
    expect(sizesOf(removeSlot(three, 2)!)).toEqual([0.6, 0.4]);
    // Opened at the left end, the first one's space goes to the one after it
    const left = splitAt(two, 0, "left", 2);
    expect(sizesOf(left)).toEqual([0.3, 0.3, 0.4]);
    expect(sizesOf(removeSlot(left, 2)!)).toEqual([0.6, 0.4]);
    // In the middle it goes to the one before
    expect(sizesOf(removeSlot(splitAt(preset(2), 0, "right", 2), 2)!)).toEqual([0.5, 0.5]);
  });

  it("merges a same-axis split into its parent after a removal", () => {
    // row [0, column [1, row [2, 3]]] → remove 1 → row [0, 2, 3]
    let t = splitAt(preset(2), 1, "bottom", 2);
    t = splitAt(t, 2, "right", 3);
    const r = removeSlot(t, 1)!;
    expect(r.kind === "split" && r.axis).toBe("row");
    expect(r.kind === "split" && r.children.length).toBe(3);
    expect(leaves(r)).toEqual([0, 2, 3]);
  });

  it("moves and swaps panes", () => {
    const moved = moveSlot(preset(4), 0, 3, "bottom");
    expect(leaves(moved)).toEqual([1, 2, 3, 0]);
    expect(moveSlot(preset(2), 0, 0, "left")).toEqual(preset(2));
    expect(leaves(swapSlots(preset(4), 0, 3))).toEqual([3, 1, 2, 0]);
  });

  it("finds paths, free slots and sets sizes", () => {
    const t = preset(4);
    expect(pathOf(t, 3)).toEqual([1, 1]);
    expect(freeSlot(t)).toBe(4);
    expect(freeSlot(splitAt(leaf(0), 0, "right", 2))).toBe(1);
    expect(sizesOf(setSizes(t, [0], [3, 1]).kind === "split" ? (setSizes(t, [0], [3, 1]) as { children: LayoutNode[] }).children[0] : t)).toEqual([0.75, 0.25]);
  });

  it("validates saved trees", () => {
    expect(validLayout(JSON.parse(JSON.stringify(preset(4))))).toEqual(preset(4));
    expect(
      validLayout({
        kind: "split",
        axis: "row",
        children: [
          { kind: "leaf", slot: 0 },
          { kind: "leaf", slot: 0 },
        ],
      }),
    ).toBeNull();
    expect(validLayout({ kind: "split", axis: "diagonal", children: [] })).toBeNull();
    expect(validLayout({ kind: "leaf", slot: -1 })).toBeNull();
    expect(validLayout(null)).toBeNull();
  });

  it("evens out every split", () => {
    const t = setSizes(splitAt(preset(2), 1, "bottom", 2), [], [0.8, 0.2]);
    const even = evenSizes(t);
    expect(even.kind === "split" && even.sizes).toEqual([0.5, 0.5]);
    expect(leaves(even)).toEqual([0, 1, 2]);
  });
});
