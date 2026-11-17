import {
  ArrowBigUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ChevronUp,
  Command,
  CornerDownLeft,
  Option,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";

// Show key combinations as icons (.claude/skills/no-ai-slop-ui, section 6: copy)
const ICONS: Record<string, { Icon: LucideIcon; label: string }> = {
  cmd: { Icon: Command, label: "Command" },
  shift: { Icon: ArrowBigUp, label: "Shift" },
  option: { Icon: Option, label: "Option" },
  ctrl: { Icon: ChevronUp, label: "Control" },
  tab: { Icon: ArrowRightToLine, label: "Tab" },
  enter: { Icon: CornerDownLeft, label: "Return" },
  up: { Icon: ArrowUp, label: "↑" },
  down: { Icon: ArrowDown, label: "↓" },
  left: { Icon: ArrowLeft, label: "←" },
  right: { Icon: ArrowRight, label: "→" },
};

const TEXT: Record<string, string> = { esc: "esc", ",": ",", ".": "." };
// Windows and Linux name their modifiers in words ("cmd" is the primary modifier, Ctrl there)
const OTHER_OS: Record<string, string> = { cmd: "Ctrl", option: "Alt", ctrl: "Ctrl" };
const iconFor = (k: string) => (isMac || !OTHER_OS[k] ? ICONS[k] : undefined);
const textFor = (k: string) => (!isMac && OTHER_OS[k]) || TEXT[k] || k.toUpperCase();

/** e.g. <Keys keys={["cmd", "k"]} /> */
export function Keys({ keys, className, onPrimary }: { keys: string[]; className?: string; onPrimary?: boolean }) {
  if (keys.length === 0) return null;
  const label = keys.map((k) => iconFor(k)?.label ?? textFor(k)).join("+");
  return (
    <kbd aria-label={label} className={cn("inline-flex shrink-0 items-center gap-0.5", className)}>
      {keys.map((k) => {
        const icon = iconFor(k);
        return (
          <span
            key={k}
            aria-hidden
            className={cn(
              "inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border px-[3px] font-mono text-[11px] leading-none",
              onPrimary ? "border-current/25 opacity-70" : "border-border text-muted-foreground",
            )}
          >
            {icon ? <icon.Icon className="size-2.5" strokeWidth={2.25} /> : textFor(k)}
          </span>
        );
      })}
    </kbd>
  );
}
