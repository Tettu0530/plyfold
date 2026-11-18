// Math in agent messages: remark-math reads $…$ and $$…$$. Models also write \(…\) and \[…\], so those are turned into
// dollars first. Code (fenced blocks and `inline code`) is left alone, so shell variables and the like stay as written.

/** Split into code and prose, keeping the code as it is */
function splitCode(text: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  // Fenced blocks (``` or ~~~, to the closing fence or the end), then inline code spans
  const re = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)|(`+)[^`\n][\s\S]*?\4/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index + (m[1] ?? "").length;
    if (start > at) parts.push({ code: false, text: text.slice(at, start) });
    parts.push({ code: true, text: text.slice(start, m.index + m[0].length) });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ code: false, text: text.slice(at) });
  return parts;
}

/** \[…\] → a $$ block, \(…\) → $…$, outside code */
export function normalizeMath(text: string): string {
  if (!text.includes("\\[") && !text.includes("\\(")) return text;
  return splitCode(text)
    .map((p) =>
      p.code
        ? p.text
        : p.text
            // A function result is used as it is (no "$" patterns), so the dollars here are literal
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => "\n$$\n" + body.trim() + "\n$$\n")
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => "$" + body.trim() + "$"),
    )
    .join("");
}
