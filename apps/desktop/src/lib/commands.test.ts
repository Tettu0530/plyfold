import { describe, expect, it } from "vitest";

import { commandsFromHistory, parseCommands } from "./commands";
import type { EventRecord } from "./types";

const frame = (id: number, update: unknown): EventRecord => ({ id, session_id: "s", ts: id, kind: "frame_in", payload: JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "x", update } }) });

describe("slash commands from ACP", () => {
  it("reads names, descriptions and hints", () => {
    expect(parseCommands([{ name: "/compact", description: " Summarize ", input: { hint: "instructions" } }, { name: "init", input: null }, { name: "" }, null])).toEqual([
      { name: "compact", description: "Summarize", hint: "instructions" },
      { name: "init", description: "", hint: null },
    ]);
    expect(parseCommands(undefined)).toEqual([]);
  });

  it("uses the last list in the log", () => {
    const events = [
      frame(1, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "old" }] }),
      frame(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      frame(3, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "new" }] }),
      { id: 4, session_id: "s", ts: 4, kind: "frame_in" as const, payload: "{broken available_commands_update" },
    ];
    expect(commandsFromHistory(events).map((c) => c.name)).toEqual(["new"]);
    expect(commandsFromHistory([])).toEqual([]);
  });
});
