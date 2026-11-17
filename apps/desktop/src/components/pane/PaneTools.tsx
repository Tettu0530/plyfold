// Pane header buttons: touched files, background shells, plan. Click to show the contents in a liquid menu
// Always shown (so you know where they are). With nothing inside, only the icon is shown, no count
import { Check, Circle, FileText, LoaderCircle, Pencil, SquareStop, SquareTerminal, CircleX, ListChecks, CircleHelp } from "lucide-react";
import { useMemo } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT, type MessageKey } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { cn } from "@/lib/utils";
import { backgroundShells, currentPlan, touchedFiles, type BackgroundShell, type ShellState } from "@/state/paneData";
import type { TranscriptItem } from "@/state/transcript";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";

const TRIGGER = "relative flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground";

/** Header button and the panel it opens */
function ToolButton({ scope, name, label, icon, badge, width, children }: { scope: string; name: string; label: string; icon: React.ReactNode; badge: React.ReactNode | null; width: string; children: React.ReactNode }) {
  const anchor = `${scope}:${name}`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  const raised = useLiquidActiveAnchors().has(anchor);
  return (
    <Popover onOpenChange={menu.onOpenChange}>
      <PopoverTrigger asChild>
        <button ref={liquidAnchor(anchor)} type="button" aria-label={label} title={label} className={cn(TRIGGER, raised && "z-[57]")}>
          {icon}
          {badge !== null && <span className="font-mono tabular">{badge}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={menu.ref as React.Ref<HTMLDivElement>}
        style={menu.style}
        side="bottom"
        align="end"
        sideOffset={6}
        className={cn("z-[58] flex max-h-96 flex-col gap-0.5 overflow-y-auto p-1.5", width, menu.moving && "opacity-0")}
      >
        <div className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">{label}</div>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="m-0 px-1.5 pb-1 text-xs text-muted-foreground">{children}</p>;
}

const relative = (path: string, base: string | null) => (base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path);

const SHELL: Record<ShellState, { label: MessageKey; Icon: typeof Check; className: string; spin?: boolean }> = {
  running: { label: "pane.shellRunning", Icon: LoaderCircle, className: "text-working", spin: true },
  done: { label: "pane.shellDone", Icon: Check, className: "text-muted-foreground" },
  failed: { label: "pane.shellFailed", Icon: CircleX, className: "text-error" },
  stopped: { label: "pane.shellStopped", Icon: SquareStop, className: "text-muted-foreground" },
  unknown: { label: "pane.shellUnknown", Icon: CircleHelp, className: "text-muted-foreground" },
};

function ShellRow({ s }: { s: BackgroundShell }) {
  const t = useT();
  const st = SHELL[s.state];
  const last = s.output.trim().split("\n").slice(-3).join("\n");
  return (
    <div className="flex flex-col gap-1 rounded-md px-1.5 py-1.5">
      <div className="flex items-center gap-2">
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 grow truncate font-mono text-xs" title={s.command}>
          {s.command}
        </span>
        <span className={cn("flex shrink-0 items-center gap-1 text-xs", st.className)}>
          <st.Icon className={cn("size-3.5", st.spin && "animate-spin")} aria-hidden />
          {t(st.label)}
        </span>
      </div>
      {last && <pre className="m-0 overflow-hidden rounded-[6px] bg-background px-2 py-1 font-mono text-xs leading-5 whitespace-pre text-muted-foreground">{last}</pre>}
      {s.id && <span className="font-mono text-xs text-muted-foreground">{s.id}</span>}
    </div>
  );
}

const PLAN_ICON: Record<string, { Icon: typeof Check; className: string; spin?: boolean }> = {
  completed: { Icon: Check, className: "text-muted-foreground" },
  in_progress: { Icon: LoaderCircle, className: "text-working", spin: true },
  pending: { Icon: Circle, className: "text-muted-foreground" },
};

export function PaneTools({ scope, items, worktree, alive }: { scope: string; items: TranscriptItem[]; worktree: string | null; alive: boolean }) {
  const t = useT();
  const files = useMemo(() => touchedFiles(items), [items]);
  const shells = useMemo(() => backgroundShells(items, alive), [items, alive]);
  const plan = useMemo(() => currentPlan(items), [items]);
  const running = shells.filter((s) => s.state === "running").length;
  const done = plan.filter((e) => e.status === "completed").length;

  return (
    <>
      <ToolButton scope={scope} name="plan" label={t("pane.plan")} icon={<ListChecks className="size-3.5" aria-hidden />} badge={plan.length ? `${done}/${plan.length}` : null} width="w-80">
          {plan.length === 0 && <Empty>{t("pane.planEmpty")}</Empty>}
          {plan.map((e, i) => {
            const p = PLAN_ICON[e.status] ?? PLAN_ICON.pending;
            return (
              <div key={i} className="flex items-start gap-2 px-1.5 py-1">
                <p.Icon className={cn("mt-0.5 size-3.5 shrink-0", p.className, p.spin && "animate-spin")} aria-hidden />
                <span className={cn("text-sm leading-snug", e.status === "completed" && "text-muted-foreground line-through")}>{e.content}</span>
              </div>
            );
          })}
        </ToolButton>
        <ToolButton
          scope={scope}
          name="shells"
          label={t("pane.shells")}
          icon={<SquareTerminal className={cn("size-3.5", running > 0 && "text-working")} aria-hidden />}
          badge={shells.length ? (running > 0 ? running : shells.length) : null}
          width="w-96"
        >
          {shells.length === 0 && <Empty>{t("pane.shellsEmpty")}</Empty>}
          {shells.map((s, i) => (
            <ShellRow key={s.id ?? i} s={s} />
          ))}
        </ToolButton>
        <ToolButton scope={scope} name="files" label={t("pane.files")} icon={<FileText className="size-3.5" aria-hidden />} badge={files.length || null} width="w-96">
          {files.length === 0 && <Empty>{t("pane.filesEmpty")}</Empty>}
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              title={inTauri ? t("pane.revealInFinder", { path: f.path }) : f.path}
              onClick={() => inTauri && void api.revealFile(f.path).catch(() => {})}
              className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent"
            >
              {f.edited ? <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("pane.fileEdited")} /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("pane.fileRead")} />}
              <span className="min-w-0 grow truncate font-mono text-xs">{relative(f.path, worktree)}</span>
              {f.count > 1 && <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">{f.count}</span>}
            </button>
          ))}
        </ToolButton>
    </>
  );
}
