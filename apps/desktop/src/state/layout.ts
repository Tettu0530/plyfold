// Pane layout as a split tree (like VS Code's editor groups). Pure functions only.
//
// A leaf shows one pane slot (an index into the store's `panes` array). A split lays its children out side by side
// (axis "row") or stacked (axis "column"), with `sizes` as fractions that add up to 1. Splits can have any number of
// children; nested splits on the same axis are merged so the tree stays flat where it can.

export type Axis = "row" | "column";
export type Edge = "left" | "right" | "top" | "bottom";
export type LayoutNode = { kind: "leaf"; slot: number } | { kind: "split"; axis: Axis; sizes: number[]; children: LayoutNode[] };

export const leaf = (slot: number): LayoutNode => ({ kind: "leaf", slot });
const split = (axis: Axis, children: LayoutNode[], sizes?: number[]): LayoutNode => ({
  kind: "split",
  axis,
  children,
  sizes: normalizeSizes(sizes ?? children.map(() => 1), children.length),
});

function normalizeSizes(sizes: number[], n: number): number[] {
  const s = Array.from({ length: n }, (_, i) => (Number.isFinite(sizes[i]) && sizes[i] > 0 ? sizes[i] : 1 / n));
  const total = s.reduce((a, b) => a + b, 0);
  return s.map((v) => v / total);
}

/** Slots in visual order (left to right, top to bottom) */
export function leaves(node: LayoutNode): number[] {
  return node.kind === "leaf" ? [node.slot] : node.children.flatMap(leaves);
}

/** The preset layouts behind the 1 / 2 / 4 buttons, filled with the given slots in order */
export function preset(count: 1 | 2 | 4, slots: number[] = [0, 1, 2, 3]): LayoutNode {
  if (count === 1) return leaf(slots[0]);
  if (count === 2) return split("row", [leaf(slots[0]), leaf(slots[1])]);
  return split("column", [split("row", [leaf(slots[0]), leaf(slots[1])]), split("row", [leaf(slots[2]), leaf(slots[3])])]);
}

/** Which preset the tree is shaped like (any sizes), or null for a custom layout */
export function presetOf(node: LayoutNode): 1 | 2 | 4 | null {
  if (node.kind === "leaf") return 1;
  const rowOfLeaves = (n: LayoutNode, k: number) =>
    n.kind === "split" && n.axis === "row" && n.children.length === k && n.children.every((c) => c.kind === "leaf");
  if (rowOfLeaves(node, 2)) return 2;
  if (node.axis === "column" && node.children.length === 2 && node.children.every((c) => rowOfLeaves(c, 2))) return 4;
  return null;
}

/** Child indexes from the root down to the leaf showing this slot */
export function pathOf(node: LayoutNode, slot: number): number[] | null {
  if (node.kind === "leaf") return node.slot === slot ? [] : null;
  for (let i = 0; i < node.children.length; i++) {
    const p = pathOf(node.children[i], slot);
    if (p) return [i, ...p];
  }
  return null;
}

/** The smallest slot index not shown in the tree */
export function freeSlot(node: LayoutNode | null): number {
  const used = new Set(node ? leaves(node) : []);
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

const axisOf = (edge: Edge): Axis => (edge === "left" || edge === "right" ? "row" : "column");
const before = (edge: Edge) => edge === "left" || edge === "top";

/** Put `newSlot` next to `target` on the given edge, taking half of the target's space */
export function splitAt(node: LayoutNode, target: number, edge: Edge, newSlot: number): LayoutNode {
  const axis = axisOf(edge);
  const go = (n: LayoutNode): LayoutNode => {
    if (n.kind === "leaf") {
      if (n.slot !== target) return n;
      return split(axis, before(edge) ? [leaf(newSlot), n] : [n, leaf(newSlot)]);
    }
    const i = n.children.findIndex((c) => c.kind === "leaf" && c.slot === target);
    if (i >= 0 && n.axis === axis) {
      // Same direction as this split: become a sibling instead of nesting
      const children = [...n.children];
      const sizes = [...n.sizes];
      const half = sizes[i] / 2;
      sizes[i] = half;
      const at = before(edge) ? i : i + 1;
      children.splice(at, 0, leaf(newSlot));
      sizes.splice(at, 0, half);
      return { ...n, children, sizes };
    }
    return { ...n, children: n.children.map(go) };
  };
  return go(node);
}

/** Take a slot out of the tree. Its space goes to its neighbours; a split left with one child is replaced by it */
export function removeSlot(node: LayoutNode, slot: number): LayoutNode | null {
  if (node.kind === "leaf") return node.slot === slot ? null : node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removeSlot(c, slot);
    if (!r) return;
    // Merge a child split on the same axis into this one (keeps the tree flat)
    if (r.kind === "split" && r.axis === node.axis) {
      r.children.forEach((cc, j) => {
        kept.push(cc);
        sizes.push(node.sizes[i] * r.sizes[j]);
      });
    } else {
      kept.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return split(node.axis, kept, sizes);
}

/** Move a slot next to another one (dragging a pane onto another pane's edge) */
export function moveSlot(node: LayoutNode, slot: number, target: number, edge: Edge): LayoutNode {
  if (slot === target) return node;
  const without = removeSlot(node, slot);
  return without ? splitAt(without, target, edge, slot) : leaf(slot);
}

/** Exchange two slots' positions (dragging a pane onto another pane's center) */
export function swapSlots(node: LayoutNode, a: number, b: number): LayoutNode {
  if (node.kind === "leaf") return node.slot === a ? leaf(b) : node.slot === b ? leaf(a) : node;
  return { ...node, children: node.children.map((c) => swapSlots(c, a, b)) };
}

/** Set the sizes of the split at `path` (dragging a divider) */
export function setSizes(node: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (node.kind === "leaf") return node;
  if (path.length === 0) return { ...node, sizes: normalizeSizes(sizes, node.children.length) };
  const [i, ...rest] = path;
  return { ...node, children: node.children.map((c, j) => (j === i ? setSizes(c, rest, sizes) : c)) };
}

/** Make every split's children equal in size */
export function evenSizes(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  return split(node.axis, node.children.map(evenSizes));
}

/** Check a saved tree: right shape, slots are unique non-negative integers, sizes are usable */
export function validLayout(saved: unknown): LayoutNode | null {
  const seen = new Set<number>();
  const go = (n: unknown, depth: number): LayoutNode | null => {
    if (!n || typeof n !== "object" || depth > 12) return null;
    const o = n as { kind?: unknown; slot?: unknown; axis?: unknown; sizes?: unknown; children?: unknown };
    if (o.kind === "leaf") {
      const s = o.slot;
      if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > 64 || seen.has(s)) return null;
      seen.add(s);
      return leaf(s);
    }
    if (o.kind === "split" && (o.axis === "row" || o.axis === "column") && Array.isArray(o.children) && o.children.length >= 2) {
      const children = o.children.map((c) => go(c, depth + 1));
      if (children.some((c) => !c)) return null;
      return split(o.axis, children as LayoutNode[], Array.isArray(o.sizes) ? (o.sizes as number[]) : undefined);
    }
    return null;
  };
  return go(saved, 0);
}
