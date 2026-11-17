// Rendering of diff lines (shared by the diff screen and inline diffs in conversations)
import type { PatchLine } from "@/lib/patch";
import { cn } from "@/lib/utils";

export const ROW: Record<PatchLine["kind"], string> = {
  ctx: "text-foreground/85",
  add: "bg-working/10 text-foreground",
  del: "bg-error/10 text-foreground",
  hunk: "mt-2 bg-card text-muted-foreground first:mt-0",
  note: "text-muted-foreground",
};

export function Num({ n }: { n: number | null }) {
  return <span className="inline-block w-10 shrink-0 pr-2 text-right text-muted-foreground/70 select-none">{n ?? ""}</span>;
}

export function Unified({ lines }: { lines: PatchLine[] }) {
  return (
    <div className="min-w-max">
      {lines.map((l, i) => (
        <div key={i} className={cn("flex pr-4 pl-1", ROW[l.kind])}>
          <Num n={l.old} />
          <Num n={l.new} />
          <span className="w-4 shrink-0 text-muted-foreground select-none">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
          <span className="whitespace-pre">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

