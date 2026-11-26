import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { applyUpdate, beginTurn, emptyTranscript, endTurn } from "@/state/transcript";
import { Transcript } from "./Transcript";

it("groups only consecutive tool calls, keeping each group where it happened, and shows actions only on the final answer", () => {
  const message = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const tool = (id: string) => ({ sessionUpdate: "tool_call", toolCallId: id, status: "completed" });
  let turn = beginTurn(emptyTranscript(), "Question");
  turn = applyUpdate(turn, tool("first"));
  turn = applyUpdate(turn, message("Progress update"));
  turn = applyUpdate(turn, tool("second"));
  turn = applyUpdate(turn, message("Final answer"));

  const quote = { label: "Quote this answer", run: () => {} };
  const working = renderToStaticMarkup(<Transcript items={turn.items} info={null} streaming busy onQuote={quote} />);
  expect(working).toContain("Progress update");
  expect(working).not.toContain("Quote this answer");

  const finished = endTurn(turn, null, "end_turn", null);
  const html = renderToStaticMarkup(<Transcript items={finished.items} info={null} streaming={false} onQuote={quote} />);
  // One group before the progress message and one after it, in order
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  expect(html.indexOf("aria-expanded")).toBeLessThan(html.indexOf("Progress update"));
  expect(html.lastIndexOf("aria-expanded")).toBeGreaterThan(html.indexOf("Progress update"));
  expect(html.lastIndexOf("aria-expanded")).toBeLessThan(html.indexOf("Final answer"));
  expect(html.indexOf("Quote this answer")).toBeGreaterThan(html.indexOf("Final answer"));
  expect(html.match(/aria-label="Quote this answer"/g)).toHaveLength(1);
});
