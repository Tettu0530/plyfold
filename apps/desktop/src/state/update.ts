// Updates from inside the app (tauri-plugin-updater). The installed app checks the release feed a little after it
// starts and every six hours; a development build never checks. The download is verified against the release's
// signature before it is installed, then the app restarts into the new version
import { create } from "zustand";

import { inTauri } from "@/lib/api";

type Update = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; done: number; total: number | null }
  | { kind: "error"; message: string };

let pending: Update = null;

export const useUpdate = create<{ state: UpdateState }>(() => ({ state: { kind: "idle" } }));
const set = (state: UpdateState) => useUpdate.setState({ state });

/** Look for a newer version. quiet: a background check, which leaves no error on screen */
export async function checkForUpdate(quiet = false) {
  if (!inTauri) return;
  const now = useUpdate.getState().state.kind;
  if (now === "checking" || now === "downloading") return;
  set({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    pending = await check();
    set(pending ? { kind: "available", version: pending.version } : { kind: "current" });
  } catch (e) {
    set(quiet ? { kind: "idle" } : { kind: "error", message: String(e) });
  }
}

/** Download the found version, install it and restart */
export async function installUpdate() {
  if (!pending) return;
  const version = pending.version;
  let done = 0;
  let total: number | null = null;
  set({ kind: "downloading", version, done, total });
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? null;
      else if (e.event === "Progress") done += e.data.chunkLength;
      set({ kind: "downloading", version, done, total });
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

/** Background checks for the installed app (called once at startup) */
export function startUpdateChecks() {
  if (!inTauri || import.meta.env.DEV) return;
  setTimeout(() => void checkForUpdate(true), 10_000);
  setInterval(() => void checkForUpdate(true), 6 * 60 * 60 * 1000);
}
