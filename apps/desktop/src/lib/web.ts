// Web tool calls in the transcript. Claude Code reports a search as `Search "query"` with its hits as "Title (url)" lines,
// and a fetch as `Fetch <url>` with the agent's answer about the page; other agents may use the same shapes.

export interface SearchHit {
  title: string;
  url: string;
  host: string;
}

/** The hits of a web search result: every non-empty line "Title (https://…)". Null when the text is something else */
export function parseSearchHits(text: string): SearchHit[] | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const hits: SearchHit[] = [];
  for (const line of lines) {
    const m = /^(.*?)\s*\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)$/.exec(line);
    if (!m) return null;
    let host: string;
    try {
      host = new URL(m[2]).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
    hits.push({ title: m[1] || host, url: m[2], host });
  }
  return hits;
}

/** The page a fetch read, from its title ("Fetch https://… (from char 100)") */
export function fetchedUrl(title: string): string | null {
  const m = /^Fetch\s+(https?:\/\/\S+)/.exec(title);
  return m ? m[1] : null;
}

/** Whether a tool call is a web search (by its title; agents report searches with the fetch kind too) */
export const isWebSearch = (title: string, toolKind: string) => toolKind === "search" || /^(Search\s+"|Web search$|Searching the web)/.test(title);
