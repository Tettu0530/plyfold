// Whether the saved-messages screen is open. Kept out of the session store so it does not share that file
import { create } from "zustand";

import type { Look } from "@/components/liquid/liquid";
import { liquidCloseFrom, liquidOpen } from "@/components/liquid/stage";

/** Same surface as Settings */
const LOOK: Look = { background: "rgba(10, 10, 10, 1)", border: "rgba(255, 255, 255, 0.1)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };

const target = () => document.querySelector<HTMLElement>("[data-prompts-view]");

type View = { anchor: string; closing: boolean };

type State = {
  view: View | null;
  open: (anchor: string) => void;
  close: () => void;
};

export const usePromptsScreen = create<State>((set, get) => ({
  view: null,
  open: (anchor) => {
    if (get().view) return;
    liquidOpen("prompts", { cover: true, anchor, target, toLook: LOOK });
    set({ view: { anchor, closing: false } });
  },
  close: () => {
    const view = get().view;
    if (!view || view.closing) return;
    set({ view: { ...view, closing: true } });
    liquidCloseFrom("prompts", {
      cover: true,
      anchor: view.anchor,
      target,
      toLook: LOOK,
      onDone: () => set({ view: null }),
    });
  },
}));

export const openPrompts = (anchor: string) => usePromptsScreen.getState().open(anchor);
