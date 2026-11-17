// Key handling for input boxes (IME composition commits and the send-key setting)
//
// In WebKit (Safari and Tauri), the keydown for the Enter that commits an IME conversion arrives after compositionend
// with isComposing false. So also check keyCode 229 (IME processing) and whether compositionend just fired
let lastCompositionEnd = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  window.addEventListener("compositionend", () => (lastCompositionEnd = performance.now()), true);
}

type AnyKeyEvent = React.KeyboardEvent | KeyboardEvent;
const native = (e: AnyKeyEvent): KeyboardEvent => ("nativeEvent" in e ? e.nativeEvent : e);

/** Whether the key is part of an IME composition or the one that just committed it */
export function isImeKey(e: AnyKeyEvent): boolean {
  const n = native(e);
  return n.isComposing || n.keyCode === 229 || performance.now() - lastCompositionEnd < 80;
}

export type SendKey = "enter" | "cmd_enter";

/**
 * Whether the key sends. enter: Enter sends, Shift+Enter inserts a newline (⌘Enter also sends).
 * cmd_enter: ⌘Enter (Ctrl+Enter) sends, Enter inserts a newline
 */
export function isSendKey(e: AnyKeyEvent, mode: SendKey): boolean {
  const n = native(e);
  if (n.key !== "Enter" || isImeKey(e)) return false;
  if (n.metaKey || n.ctrlKey) return true;
  return mode === "enter" && !n.shiftKey;
}

/** How to display the send key (passed to Keys) */
export const sendKeys = (mode: SendKey) => (mode === "cmd_enter" ? ["cmd", "enter"] : ["enter"]);
