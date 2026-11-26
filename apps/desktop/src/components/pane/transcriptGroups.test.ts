import { describe, expect, it } from "vitest";

import { groupTools } from "./Transcript";
import type { TranscriptItem } from "@/state/transcript";

const tool = (id: string) => ({ kind: "tool", id }) as unknown as TranscriptItem;
const agent = (text: string) => ({ kind: "agent", text }) as unknown as TranscriptItem;

describe("groupTools", () => {
  it("groups only tool calls that follow one another", () => {
    const blocks = groupTools([agent("read"), tool("1"), tool("2"), agent("check"), tool("3"), agent("found"), tool("4"), tool("5"), tool("6")]);
    expect(blocks.map((b) => b.kind)).toEqual(["agent", "tools", "agent", "tools", "agent", "tools"]);
    expect(blocks.map((b) => (b.kind === "tools" ? b.tools.length : 0))).toEqual([0, 2, 0, 1, 0, 3]);
  });
});
