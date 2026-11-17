// Current keyboard shortcuts (defaults plus the user's changes in Settings)
import { useMemo } from "react";

import { bindingsOf, keysOf, type Action, type Bindings } from "@/lib/keymap";
import { useStore } from "./store";

export function useBindings(): Bindings {
  const overrides = useStore((s) => s.settings.keybindings);
  return useMemo(() => bindingsOf(overrides), [overrides]);
}

/** Keys of an action's shortcut for <Keys> (empty when unbound) */
export function useKeys(action: Action): string[] {
  return keysOf(useBindings()[action]);
}

export const currentBindings = () => bindingsOf(useStore.getState().settings.keybindings);
