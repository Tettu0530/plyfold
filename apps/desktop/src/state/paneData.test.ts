import { describe, expect, it } from "vitest";

import { backgroundShells, currentPlan, touchedFiles } from "./paneData";
import { applyUpdate, emptyTranscript } from "./transcript";

const run = (updates: Record<string, unknown>[]) =>
  updates.reduce((t, u, i) => applyUpdate(t, { sessionUpdate: "tool_call", ...u } as never, i), emptyTranscript()).items;

describe("paneData", () => {
  it("lists touched files, edited ones marked", () => {
    const items = run([
      { toolCallId: "a", kind: "read", title: "Read a.md", locations: [{ path: "/w/a.md" }], status: "completed" },
      { toolCallId: "b", kind: "edit", title: "Write b.rs", content: [{ type: "diff", path: "/w/b.rs", oldText: null, newText: "x" }], status: "completed" },
      { toolCallId: "c", kind: "execute", title: "ls", rawInput: { command: "ls" }, status: "completed" },
    ]);
    const files = touchedFiles(items);
    expect(files.map((f) => [f.path, f.edited])).toEqual([
      ["/w/b.rs", true],
      ["/w/a.md", false],
    ]);
  });

  it("follows a background shell by its ID", () => {
    const items = run([
      {
        toolCallId: "s",
        kind: "execute",
        title: "npm run dev",
        rawInput: { command: "npm run dev", run_in_background: true },
        rawOutput: "Command running in background with ID: bash_1",
        status: "completed",
      },
      {
        toolCallId: "o",
        kind: "other",
        title: "TaskOutput",
        _meta: { claudeCode: { toolName: "TaskOutput" } },
        rawInput: { task_id: "bash_1" },
        rawOutput: "<status>running</status>\nready on :1420",
        status: "completed",
      },
    ]);
    const [sh] = backgroundShells(items, true);
    expect(sh).toMatchObject({ id: "bash_1", command: "npm run dev", state: "running" });
    expect(sh.output).toContain("ready on :1420");

    const stopped = run([
      ...[
        {
          toolCallId: "s",
          kind: "execute",
          title: "x",
          rawInput: { command: "x", run_in_background: true },
          rawOutput: "with ID: bash_2",
          status: "completed",
        },
      ],
      {
        toolCallId: "k",
        kind: "other",
        title: "KillShell",
        _meta: { claudeCode: { toolName: "KillShell" } },
        rawInput: { shell_id: "bash_2" },
        status: "completed",
      },
    ]);
    expect(backgroundShells(stopped, true)[0].state).toBe("stopped");
    expect(backgroundShells(run([{ toolCallId: "s", rawInput: { command: "y", run_in_background: true }, rawOutput: "ID: bash_3" }]), false)[0].state).toBe(
      "unknown",
    );
  });

  it("returns the latest plan", () => {
    let t = applyUpdate(emptyTranscript(), { sessionUpdate: "plan", entries: [{ content: "a", status: "pending" }] });
    t = applyUpdate(t, {
      sessionUpdate: "plan",
      entries: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(currentPlan(t.items).map((e) => e.status)).toEqual(["completed", "in_progress"]);
  });
});
