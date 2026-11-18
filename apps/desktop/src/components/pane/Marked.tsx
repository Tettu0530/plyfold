// Highlight matches of a find query in plain text (a sent message, a command). The occurrence index matches findMatches.

import { spansIn } from "@/state/find";
import { cn } from "@/lib/utils";

export function Marked({ text, query, active }: { text: string; query: string; active: number | null }) {
  const spans = spansIn(text, query);
  if (spans.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(
      <span
        key={i}
        data-find-hit={i}
        className={cn("rounded-sm bg-foreground/12", i === active && "bg-foreground/35 text-foreground ring-1 ring-foreground/60")}
      >
        {text.slice(s.start, s.end)}
      </span>,
    );
    at = s.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
