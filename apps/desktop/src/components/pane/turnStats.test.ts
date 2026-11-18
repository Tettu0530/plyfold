import { describe, expect, it } from "vitest";

import { usedNoTokens } from "./Transcript";

const usage = (input: number, output: number, cached = 0) => ({ input, output, cached_read: cached, cached_write: 0, thought: 0, total: input + output });
const stats = (u: ReturnType<typeof usage> | null) => ({ usage: u, elapsed_ms: 600, ttft_ms: null, tokens_per_sec: null, estimated: false });

describe("turn stats", () => {
  it("tells a local command (no tokens either way) from a model turn", () => {
    // /usage, /context: answered by the agent itself
    expect(usedNoTokens(stats(usage(0, 0)))).toBe(true);
    expect(usedNoTokens(stats(usage(2, 101, 11256)))).toBe(false);
    // Only cache reads still went to the model
    expect(usedNoTokens(stats(usage(0, 0, 500)))).toBe(false);
  });

  it("says nothing when the agent reports no usage", () => {
    expect(usedNoTokens(stats(null))).toBe(false);
    expect(usedNoTokens(null)).toBe(false);
  });
});
