// Local web addresses printed by commands (dev servers and the like), for the preview pane

// Terminal colour codes (Vite and others colour their "Local:" line)
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const LOCAL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'`<>)\]]*)?/g;

/** localhost URLs in the text, in order of appearance, without duplicates. 0.0.0.0 becomes localhost */
export function localUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.replace(ANSI, "").matchAll(LOCAL)) {
    const url = m[0].replace("//0.0.0.0", "//localhost").replace(/[.,;:]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** What the user typed in the address field, as a URL: adds http:// when no scheme is given */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
