// Per-OS differences in the UI. Outside a browser (tests) this counts as macOS, the platform the app was built on

export const isMac = typeof navigator === "undefined" || /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The primary shortcut modifier: ⌘ on macOS, Ctrl on Windows and Linux */
export const primaryKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);
