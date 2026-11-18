// Settings → Keyboard: change the app's shortcuts. Click a shortcut and press the new keys; esc cancels and delete
// removes it. A combo that another action uses moves to the new action (the other one is left without a shortcut)
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { useT, type MessageKey } from "@/i18n";
import { ACTIONS, DEFAULT_BINDINGS, comboOf, comboProblem, keysOf, rebind, type Action } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import { useBindings } from "@/state/keys";
import { useStore } from "@/state/store";
import { Keys } from "./Keys";

const LABEL: Record<Action, MessageKey> = {
  newSession: "settings.kbNewSession",
  search: "settings.kbSearch",
  find: "settings.kbFind",
  settings: "settings.kbSettings",
  toggleSidebar: "settings.kbToggleSidebar",
  stop: "settings.kbStop",
  attach: "settings.kbAttach",
  splitRight: "settings.kbSplitRight",
  splitDown: "settings.kbSplitDown",
  evenLayout: "settings.kbEvenLayout",
  closePane: "settings.kbClosePane",
  focusNext: "settings.kbFocusNext",
  focusPrev: "settings.kbFocusPrev",
  zoomIn: "settings.kbZoomIn",
  zoomOut: "settings.kbZoomOut",
  zoomReset: "settings.kbZoomReset",
  openDiff: "settings.kbOpenDiff",
  sideChat: "settings.kbSideChat",
};

export function ShortcutSettings({ onError }: { onError: (e: string) => void }) {
  const t = useT();
  const bindings = useBindings();
  const overrides = useStore((s) => s.settings.keybindings);
  const save = useStore((s) => s.saveSettings);
  const [recording, setRecording] = useState<Action | null>(null);
  // A note under one row: why a combo was refused, or which action lost it
  const [note, setNote] = useState<{ action: Action; text: string } | null>(null);

  const apply = (action: Action, combo: string) => {
    const r = rebind(overrides, action, combo);
    setNote(r.moved ? { action, text: t("settings.kbMoved", { action: t(LABEL[r.moved]) }) } : null);
    save({ keybindings: r.overrides }).catch((e) => onError(String(e)));
  };

  // While recording, every key goes to the recorder (capture phase on window, so no shortcut or esc-to-close fires)
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (plain && e.key === "Escape") return setRecording(null);
      if (plain && (e.key === "Backspace" || e.key === "Delete")) {
        apply(recording, "");
        return setRecording(null);
      }
      const combo = comboOf(e);
      // Only a modifier so far: keep waiting for the key
      if (!combo) return;
      const problem = comboProblem(combo);
      if (problem) return setNote({ action: recording, text: t(problem === "reserved" ? "settings.kbReserved" : "settings.kbNeedsModifier") });
      apply(recording, combo);
      setRecording(null);
    };
    const cancel = () => setRecording(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides]);

  const changed = Object.keys(overrides ?? {}).length > 0;
  return (
    <div className="flex flex-col gap-1">
      {ACTIONS.map((a) => {
        const combo = bindings[a];
        const isDefault = combo === DEFAULT_BINDINGS[a];
        return (
          <div key={a} className="flex flex-col">
            <div className="flex h-9 items-center gap-2">
              <span className="grow">{t(LABEL[a])}</span>
              {!isDefault && (
                <button
                  type="button"
                  aria-label={t("settings.kbReset", { action: t(LABEL[a]) })}
                  title={t("settings.kbResetOne")}
                  onClick={() => apply(a, DEFAULT_BINDINGS[a])}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                </button>
              )}
              <button
                type="button"
                aria-label={t("settings.kbChange", { action: t(LABEL[a]) })}
                aria-pressed={recording === a}
                onClick={() => {
                  setNote(null);
                  setRecording(recording === a ? null : a);
                }}
                className={cn(
                  "flex h-7 min-w-28 items-center justify-center rounded-md border px-2 text-xs",
                  recording === a ? "border-foreground/40 bg-accent text-foreground" : "border-input text-muted-foreground hover:bg-accent",
                )}
              >
                {recording === a ? t("settings.kbPress") : combo ? <Keys keys={keysOf(combo)} /> : t("settings.kbNone")}
              </button>
            </div>
            {note?.action === a && <p className="m-0 pb-1 text-right text-xs text-muted-foreground">{note.text}</p>}
          </div>
        );
      })}
      {/* ⌘1–⌘9 can't be changed */}
      <div className="flex h-9 items-center gap-2" title={t("settings.kbFixed")}>
        <span className="grow">{t("settings.kbFocusPane")}</span>
        <span className="flex h-7 min-w-28 items-center justify-center gap-1 px-2 text-xs text-muted-foreground">
          <Keys keys={["cmd", "1"]} />
          –
          <Keys keys={["cmd", "9"]} />
        </span>
      </div>
      {changed && (
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={() => {
              setNote(null);
              save({ keybindings: {} }).catch((e) => onError(String(e)));
            }}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {t("settings.kbResetAll")}
          </button>
        </div>
      )}
    </div>
  );
}
