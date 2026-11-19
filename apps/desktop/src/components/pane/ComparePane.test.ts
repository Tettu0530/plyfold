import { describe, expect, it } from "vitest";

import { totals } from "./ComparePane";
import type { SessionView } from "@/state/store";

const stats = (input: number, output: number, ms: number, cached = 0) => ({
  kind: "stats" as const,
  stats: {
    usage: { input, output, cached_read: cached, cached_write: 0, thought: 0, total: input + output },
    elapsed_ms: ms,
    ttft_ms: null,
    tokens_per_sec: null,
    estimated: false,
  },
  stopReason: "end_turn",
  error: null,
  endedAt: 0,
});

describe("comparing sessions", () => {
  it("adds up each turn's time and tokens", () => {
    const v = {
      transcript: { items: [{ kind: "user", text: "go" }, stats(100, 10, 2000, 50), { kind: "agent", text: "ok" }, stats(200, 20, 3000)], inTurn: false },
    } as unknown as SessionView;
    expect(totals(v)).toEqual({ ms: 5000, input: 350, output: 30, turns: 2 });
  });

  it("is empty before any turn has ended", () => {
    const v = { transcript: { items: [{ kind: "user", text: "go" }], inTurn: true } } as unknown as SessionView;
    expect(totals(v)).toEqual({ ms: 0, input: 0, output: 0, turns: 0 });
  });
});
