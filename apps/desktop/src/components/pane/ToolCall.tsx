// A tool call in the transcript. Click the row to reveal the command and its result (progressive disclosure)
import { Check, ChevronRight, CircleX, FileText, LoaderCircle, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { useT } from "@/i18n";
import { seconds } from "@/lib/format";

import { lineDiff } from "@/lib/lineDiff";
import { cn } from "@/lib/utils";
import type { DiffPreview, ToolCall } from "@/state/transcript";
import { smooth, snappy } from "../motion";
import { Unified } from "../PatchLines";

const TOOL_ICONS: Record<string, typeof FileText> = {
  read: FileText,
  search: Search,
  edit: Pencil,
  execute: SquareTerminal,
};

/** Result lines shown at first. Click for the rest (no scrolling while collapsed) */
const FIRST_LINES = 12;

/** Re-render at a fixed interval only while running (to count elapsed time) */
function useNow(active: boolean, ms = 100) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

const shortPath = (p: string) => p.split("/").slice(-3).join("/");

function Status({ t }: { t: ToolCall }) {
  const tr = useT();
  const running = t.status === "pending" || t.status === "in_progress";
  const now = useNow(running);
  // Count elapsed time while running; show the duration once done
  const elapsed = t.startedAt != null ? (running ? now : (t.endedAt ?? t.startedAt)) - t.startedAt : null;
  const time = elapsed != null && (running || elapsed >= 100) ? <span className="font-mono tabular">{seconds(Math.max(0, elapsed))}</span> : null;
  if (running)
    return (
      <span className="flex items-center gap-1 text-xs text-working">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        {tr("transcript.toolRunning")}
        {time}
      </span>
    );
  if (t.status === "failed" || (t.exitCode != null && t.exitCode !== 0))
    return (
      <span className="flex items-center gap-1 font-mono text-xs text-error tabular">
        <CircleX className="size-3.5" aria-hidden />
        {t.exitCode != null && t.exitCode !== 0 ? (
          <>
            <span className="font-sans">{tr("transcript.exitCode")}</span>
            {t.exitCode}
          </>
        ) : (
          <span className="font-sans">{tr("transcript.toolFailed")}</span>
        )}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Check className="size-3.5" aria-hidden />
      {tr("transcript.toolDone")}
      {time}
    </span>
  );
}

/** Show only the first lines of long text; click for the rest */
function useClamp(text: string, first: number) {
  const t = useT();
  const [all, setAll] = useState(false);
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const rest = all ? 0 : Math.max(0, lines.length - first);
  // The count is rendered in a monospace element, so split the translated text around {n}
  const [before, after = ""] = t("transcript.showMore", { count: rest }).split("{n}");
  const more = rest > 0 && (
    <button
      type="button"
      onClick={() => setAll(true)}
      className="flex h-7 w-full items-center px-3 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {before}
      <span className="mx-1 font-mono tabular">{rest}</span>
      {after}
    </button>
  );
  return { text: rest ? lines.slice(0, first).join("\n") : lines.join("\n"), more, folded: rest > 0 };
}

/** Result text */
function Output({ text }: { text: string }) {
  const c = useClamp(text, FIRST_LINES);
  return (
    <div className="overflow-hidden rounded-md bg-background">
      {/* While collapsed, only the first lines (no scrolling). Once fully shown, cap the height and scroll */}
      <pre
        className={cn(
          "m-0 px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-foreground/85 select-text",
          c.folded ? "overflow-x-auto overflow-y-hidden" : "max-h-80 overflow-auto",
        )}
      >
        {c.text}
      </pre>
      {c.more}
    </div>
  );
}

/** The executed command (long ones such as heredocs are collapsed) */
function Command({ text }: { text: string }) {
  const c = useClamp(text, 12);
  return (
    <div>
      <pre className="m-0 font-mono text-xs leading-5 break-all whitespace-pre-wrap select-text">
        <span className="text-muted-foreground select-none">$ </span>
        {c.text}
      </pre>
      {c.more && <div className="-mx-3">{c.more}</div>}
    </div>
  );
}

function Detail({ t }: { t: ToolCall }) {
  const tr = useT();
  const output = t.stream || t.result;
  // File contents read or written are clear from the diff or title, so show only the path
  // Short commands fully readable in the title are not shown again
  const showCommand = !!t.command && (t.command !== t.title || t.command.length > 60);
  const showPath = t.path && t.toolKind !== "execute" && !t.title.includes(shortPath(t.path));
  return (
    <div className="flex flex-col gap-2 px-3 pt-0.5 pb-3">
      {t.note && <p className="m-0 text-xs text-muted-foreground">{t.note}</p>}
      {showCommand && <Command text={t.command!} />}
      {showPath && <p className="m-0 font-mono text-xs break-all text-muted-foreground select-text">{t.path}</p>}
      {output ? (
        <Output text={output} />
      ) : (
        !showCommand && !showPath && !t.note && <p className="m-0 text-xs text-muted-foreground">{tr("transcript.noResult")}</p>
      )}
    </div>
  );
}

function ToolRow({ t, first }: { t: ToolCall; first: boolean }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[t.toolKind] ?? Wrench;
  const hasDetail = !!(t.command || t.path || t.note || t.stream || t.result);
  const title = t.title || t.command || tr("transcript.tool");
  return (
    <div className={cn(!first && "border-t")}>
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
        className={cn("flex h-9 w-full items-center gap-3 px-3 text-left", hasDetail && "hover:bg-accent/50")}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 grow truncate font-mono text-xs" title={title}>
          {title}
        </span>
        <span className="flex shrink-0">
          <Status t={t} />
        </span>
        {hasDetail && (
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={snappy} className="flex text-muted-foreground">
            <ChevronRight className="size-3.5" aria-hidden />
          </motion.span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={smooth}
            className="overflow-hidden"
          >
            <Detail t={t} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Consecutive tool calls in one frame */
export function ToolCalls({ tools }: { tools: ToolCall[] }) {
  return (
    <div className="overflow-hidden rounded-[10px] border bg-card">
      {tools.map((t, j) => (
        <ToolRow key={t.id || j} t={t} first={j === 0} />
      ))}
    </div>
  );
}

/** A file diff in the transcript. Click the header to collapse */
export function DiffBlock({ d }: { d: DiffPreview }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const diff = useMemo(() => lineDiff(d.oldText, d.newText), [d.oldText, d.newText]);
  return (
    <figure className="m-0 overflow-hidden rounded-[10px] border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-accent/50"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={snappy} className="flex text-muted-foreground">
          <ChevronRight className="size-3.5" aria-hidden />
        </motion.span>
        <span className="min-w-0 grow truncate font-mono text-xs" title={d.path}>
          {shortPath(d.path)}
        </span>
        {d.oldText == null && <span className="text-xs text-muted-foreground">{t("transcript.newFile")}</span>}
        <span className="font-mono text-xs tabular">
          <span className="text-working">+{diff.added}</span> <span className="text-error">−{diff.removed}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="lines"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={smooth}
            className="overflow-hidden border-t"
          >
            <div className="max-h-72 overflow-auto py-1 font-mono text-xs leading-5 select-text">
              <Unified lines={diff.lines} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </figure>
  );
}
