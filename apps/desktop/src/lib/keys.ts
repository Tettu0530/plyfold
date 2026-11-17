// 入力欄のキーの判定（日本語入力の確定と、送るキーの設定）
//
// WebKit（Safari と Tauri）では、変換を確定する Enter の keydown が compositionend の後に届き、
// isComposing が false になる。keyCode 229（IME が処理中）と、compositionend の直後かも見る
let lastCompositionEnd = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  window.addEventListener("compositionend", () => (lastCompositionEnd = performance.now()), true);
}

type AnyKeyEvent = React.KeyboardEvent | KeyboardEvent;
const native = (e: AnyKeyEvent): KeyboardEvent => ("nativeEvent" in e ? e.nativeEvent : e);

/** 日本語入力などの変換中、または確定したばかりのキーか */
export function isImeKey(e: AnyKeyEvent): boolean {
  const n = native(e);
  return n.isComposing || n.keyCode === 229 || performance.now() - lastCompositionEnd < 80;
}

export type SendKey = "enter" | "cmd_enter";

/**
 * 送るキーか。enter: Enter で送り、Shift+Enter で改行（⌘Enter でも送る）。
 * cmd_enter: ⌘Enter（Ctrl+Enter）で送り、Enter は改行
 */
export function isSendKey(e: AnyKeyEvent, mode: SendKey): boolean {
  const n = native(e);
  if (n.key !== "Enter" || isImeKey(e)) return false;
  if (n.metaKey || n.ctrlKey) return true;
  return mode === "enter" && !n.shiftKey;
}

/** 送るキーの見せ方（Keys に渡す） */
export const sendKeys = (mode: SendKey) => (mode === "cmd_enter" ? ["cmd", "enter"] : ["enter"]);
