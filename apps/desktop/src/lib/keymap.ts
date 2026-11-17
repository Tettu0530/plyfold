import { isMac } from "./platform";

// Keyboard shortcuts that can be changed in Settings.
// "cmd" means the primary modifier: ⌘ on macOS, Ctrl on Windows (shortcuts carry over between the two).
//
// A combo is written "cmd+shift+\\": modifiers in a fixed order (cmd, ctrl, option, shift) and then one key. Keys come
// from KeyboardEvent.code (the physical key), so ⌥ and ⇧ don't change which key was pressed; the ¥ key on Japanese
// keyboards counts as "\\". Settings store only the overrides; "" unbinds an action.
// ⌘1–⌘9 (focus a pane) and the keys inside the composer stay fixed.

export const ACTIONS = [
  "newSession",
  "search",
  "settings",
  "toggleSidebar",
  "stop",
  "attach",
  "splitRight",
  "splitDown",
  "evenLayout",
  "closePane",
  "focusNext",
  "focusPrev",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "openDiff",
  "sideChat",
] as const;
export type Action = (typeof ACTIONS)[number];
export type Bindings = Record<Action, string>;

export const DEFAULT_BINDINGS: Bindings = {
  newSession: "cmd+n",
  search: "cmd+k",
  settings: "cmd+,",
  toggleSidebar: "cmd+b",
  stop: "cmd+.",
  attach: "cmd+u",
  splitRight: "cmd+\\",
  splitDown: "cmd+shift+\\",
  evenLayout: "",
  closePane: "",
  focusNext: "cmd+]",
  focusPrev: "cmd+[",
  zoomIn: "cmd+=",
  zoomOut: "cmd+-",
  zoomReset: "cmd+0",
  openDiff: "cmd+shift+d",
  sideChat: "cmd+j",
};

const MODS = ["cmd", "ctrl", "option", "shift"] as const;

const CODES: Record<string, string> = {
  Backslash: "\\",
  IntlYen: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "space",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The key of a keyboard event, or null for modifier keys and keys we don't bind */
function keyOf(e: Pick<KeyboardEvent, "code">): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^F([1-9]|1[0-9])$/.test(e.code)) return e.code.toLowerCase();
  return CODES[e.code] ?? null;
}

type KeyEventLike = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/**
 * The combo a keyboard event makes, or null if it is only a modifier (or a key we don't bind). `mac` defaults to the
 * running OS: "cmd" is the primary modifier, ⌘ on macOS and Ctrl elsewhere (where Ctrl has no separate meaning)
 */
export function comboOf(e: KeyEventLike, mac = isMac): string | null {
  const key = keyOf(e);
  if (!key) return null;
  const on = { cmd: mac ? e.metaKey : e.ctrlKey, ctrl: mac && e.ctrlKey, option: e.altKey, shift: e.shiftKey };
  return [...MODS.filter((m) => on[m]), key].join("+");
}

/** Keys for <Keys> (["cmd", "shift", "\\"]); empty when unbound */
export const keysOf = (combo: string): string[] => (combo ? combo.split(/\+(?!$)/) : []);

/** Defaults with the user's overrides applied (unknown actions and malformed values are ignored) */
export function bindingsOf(overrides: Record<string, string> | undefined): Bindings {
  const out = { ...DEFAULT_BINDINGS };
  for (const [a, c] of Object.entries(overrides ?? {})) {
    if ((ACTIONS as readonly string[]).includes(a) && typeof c === "string" && (c === "" || validCombo(c))) out[a as Action] = c;
  }
  return out;
}

const KEY_RE = /^([a-z0-9]|f([1-9]|1[0-9])|[\\,./;'[\]\-=`]|space|enter|tab|backspace|delete|up|down|left|right)$/;
function validCombo(c: string): boolean {
  const parts = keysOf(c);
  const key = parts.pop();
  return (
    !!key &&
    KEY_RE.test(key) &&
    parts.every(
      (m, i) =>
        MODS.includes(m as (typeof MODS)[number]) && MODS.indexOf(m as (typeof MODS)[number]) > (i ? MODS.indexOf(parts[i - 1] as (typeof MODS)[number]) : -1),
    )
  );
}

/** The action a keyboard event triggers */
export function actionFor(e: KeyEventLike, bindings: Bindings, mac = isMac): Action | null {
  const c = comboOf(e, mac);
  if (!c) return null;
  return ACTIONS.find((a) => bindings[a] === c) ?? null;
}

/** Combos that macOS or text editing already use (and ⌘1–⌘9, which focus panes) */
const RESERVED = new Set([
  "cmd+c",
  "cmd+v",
  "cmd+x",
  "cmd+a",
  "cmd+z",
  "cmd+shift+z",
  "cmd+q",
  "cmd+w",
  "cmd+h",
  "cmd+m",
  "cmd+tab",
  "cmd+space",
  ...Array.from({ length: 9 }, (_, i) => `cmd+${i + 1}`),
]);

export type ComboProblem = "needsModifier" | "reserved";

/** Why a recorded combo can't be used, or null if it can. Needs ⌘ or ⌃ (or an F key) so typing never triggers it */
export function comboProblem(combo: string): ComboProblem | null {
  if (RESERVED.has(combo)) return "reserved";
  const parts = keysOf(combo);
  const key = parts[parts.length - 1];
  if (!parts.includes("cmd") && !parts.includes("ctrl") && !/^f\d+$/.test(key)) return "needsModifier";
  return null;
}

/**
 * Overrides after binding `action` to `combo`: another action using the same combo is unbound (returned as `moved`),
 * and values equal to the default are dropped so the settings file only keeps real changes
 */
export function rebind(
  overrides: Record<string, string> | undefined,
  action: Action,
  combo: string,
): { overrides: Record<string, string>; moved: Action | null } {
  const current = bindingsOf(overrides);
  const moved = combo ? (ACTIONS.find((a) => a !== action && current[a] === combo) ?? null) : null;
  const next: Bindings = { ...current, [action]: combo };
  if (moved) next[moved] = "";
  const out: Record<string, string> = {};
  for (const a of ACTIONS) if (next[a] !== DEFAULT_BINDINGS[a]) out[a] = next[a];
  return { overrides: out, moved };
}
