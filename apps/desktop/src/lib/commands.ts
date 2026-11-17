// Slash commands from ACP available_commands_update (the same reading as crates/plyfold-core/src/info.rs)
import type { EventRecord, SlashCommand } from "./types";

export function parseCommands(list: unknown): SlashCommand[] {
  if (!Array.isArray(list)) return [];
  const out: SlashCommand[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const o = c as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null };
    // Some agents include the leading slash in the name
    const name = typeof o.name === "string" ? o.name.trim().replace(/^\/+/, "") : "";
    if (!name) continue;
    const hint = typeof o.input?.hint === "string" && o.input.hint.trim() ? o.input.hint.trim() : null;
    out.push({ name, description: typeof o.description === "string" ? o.description.trim() : "", hint });
  }
  return out;
}

/** The last command list the agent sent in a session's log (for sessions that aren't running) */
export function commandsFromHistory(events: EventRecord[]): SlashCommand[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.kind !== "frame_in" && e.kind !== "fork_in") || !e.payload.includes("available_commands_update")) continue;
    try {
      const u = JSON.parse(e.payload)?.params?.update;
      if (u?.sessionUpdate === "available_commands_update") return parseCommands(u.availableCommands);
    } catch {
      // A broken line in the log: keep looking further back
    }
  }
  return [];
}
