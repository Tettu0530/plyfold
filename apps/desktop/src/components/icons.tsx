import claudeLogo from "@/assets/claude.svg";
import codexLogo from "@/assets/codex.svg";
import geminiLogo from "@/assets/gemini.svg";
import opencodeLogo from "@/assets/opencode.svg";
import {
  Circle,
  CircleX,
  FilePen,
  Hand,
  Hourglass,
  ListChecks,
  PencilLine,
  Repeat,
  Shield,
  ShieldOff,
  Square,
  SquareTerminal,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { forwardRef } from "react";

import { t, useT, type MessageKey } from "@/i18n";
import type { SessionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";

const PROVIDER_LOGOS = new Map([
  ["claude", claudeLogo],
  ["codex", codexLogo],
  ["gemini", geminiLogo],
  ["opencode", opencodeLogo],
]);

export const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  // Look up in the current language at render time (resolving at load time would ignore language changes)
  get mock() {
    return t("status.agentMock");
  },
};

/** The agent's display name: built-in ones by name, ones added from the ACP Registry by the name they came with */
export function agentName(agent: string): string {
  return AGENT_NAMES[agent] ?? useStore.getState().profiles.find((p) => p.agent === agent && p.agent_name)?.agent_name ?? agent;
}

/** A profile's name for pickers: a default profile is named by its agent ("Claude Code"), not "default" */
export function profileTitle(p: { name: string; agent: string; label: string }): string {
  return p.name === p.agent ? agentName(p.agent) : p.label || p.name;
}

/** A profile as one picker row: its agent's logo and its name */
export function ProfileOption({ profile, className }: { profile: { name: string; agent: string; label: string }; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <ProviderLogo agent={profile.agent} className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{profileTitle(profile)}</span>
    </span>
  );
}

export function ProviderLogo({ agent, className }: { agent: string; className?: string }) {
  const logo = PROVIDER_LOGOS.get(agent);
  const icon = useStore((s) => (logo ? null : (s.profiles.find((p) => p.agent === agent && p.agent_icon)?.agent_icon ?? null)));
  const size = cn("size-3.5 shrink-0", className);
  if (logo) return <img src={logo} alt="" aria-hidden className={cn("object-contain", size)} />;
  // Registry icons inherit the text color.
  if (icon) {
    const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(icon)}")`;
    return (
      <span
        aria-hidden
        className={cn("inline-block size-3.5 shrink-0 bg-current", className)}
        style={{
          maskImage: url,
          WebkitMaskImage: url,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
        }}
      />
    );
  }
  return <SquareTerminal aria-hidden className={size} />;
}

/**
 * The working spinner: twelve short bars around a circle that fade one after another. Takes the same props as a
 * lucide icon (size and color from className, currentColor), so it fits where those go
 */
export const Spinner = forwardRef<SVGSVGElement, LucideProps>(function Spinner({ className, strokeWidth: _w, ...rest }, ref) {
  return (
    <svg ref={ref} viewBox="0 0 24 24" fill="currentColor" className={cn("size-3.5", className)} {...rest}>
      {Array.from({ length: 12 }, (_, i) => (
        <rect
          key={i}
          x="11"
          y="1.5"
          width="2"
          height="6"
          rx="1"
          transform={`rotate(${i * 30} 12 12)`}
          className="spinner-bar"
          style={{ animationDelay: `${(i - 12) * 0.1}s` }}
        />
      ))}
    </svg>
  );
}) as unknown as LucideIcon;

interface StatusMeta {
  /** Dictionary key for the display name */
  labelKey: MessageKey;
  /** Display name (resolved in the current language on every read) */
  readonly label: string;
  Icon: LucideIcon;
  /** Tailwind text color */
  color: string;
  spin?: boolean;
}

const statusMeta = (labelKey: MessageKey, rest: Omit<StatusMeta, "labelKey" | "label">): StatusMeta => ({
  labelKey,
  get label() {
    return t(labelKey);
  },
  ...rest,
});

export const STATUS: Record<SessionStatus, StatusMeta> = {
  starting: statusMeta("status.starting", { Icon: Spinner, color: "text-muted-foreground" }),
  working: statusMeta("status.working", { Icon: Spinner, color: "text-working" }),
  awaiting_permission: statusMeta("status.awaitingPermission", { Icon: Shield, color: "text-permission" }),
  stalled: statusMeta("status.stalled", { Icon: Hourglass, color: "text-stalled" }),
  error: statusMeta("status.error", { Icon: CircleX, color: "text-error" }),
  idle: statusMeta("status.idle", { Icon: Circle, color: "text-muted-foreground" }),
  closed: statusMeta("status.closed", { Icon: Square, color: "text-muted-foreground" }),
};

/** A conversation is answering rather than working (the same state, said the way a chat would) */
export function statusLabelKey(status: SessionStatus, chat?: boolean): MessageKey {
  return chat && status === "working" ? "status.answering" : STATUS[status].labelKey;
}

export function StatusIcon({ status, chat, className }: { status: SessionStatus; chat?: boolean; className?: string }) {
  const t = useT();
  const m = STATUS[status];
  return (
    <m.Icon
      role="img"
      aria-label={t(statusLabelKey(status, chat))}
      strokeWidth={2.25}
      className={cn("size-3.5 shrink-0", m.color, m.spin && "animate-spin [animation-duration:1.1s]", className)}
    />
  );
}

const MODE_ICONS: Record<string, LucideIcon> = {
  default: Hand,
  acceptEdits: FilePen,
  plan: ListChecks,
  auto: Repeat,
  bypassPermissions: ShieldOff,
  "workspace-write": PencilLine,
  "agent-full-access": ShieldOff,
};

export function ModeIcon({ mode, className }: { mode: string | null; className?: string }) {
  const Icon = (mode && MODE_ICONS[mode]) || PencilLine;
  return <Icon aria-hidden className={cn("size-3 shrink-0", className)} />;
}

/** Display names for modes (agent-reported id -> dictionary key). Unknown modes show the raw id */
const MODE_LABELS: Record<string, MessageKey> = {
  // Claude Code
  default: "status.modeDefault",
  acceptEdits: "status.modeAcceptEdits",
  plan: "status.modePlan",
  auto: "status.modeAuto",
  bypassPermissions: "status.modeBypassPermissions",
  // Codex
  "read-only": "status.modeReadOnly",
  "workspace-write": "status.modeWorkspaceWrite",
  agent: "status.modeAgent",
  "agent-full-access": "status.modeAgentFullAccess",
  // OpenCode
  build: "status.modeBuild",
};

export const modeLabel = (mode: string | null) => (mode ? (MODE_LABELS[mode] ? t(MODE_LABELS[mode]) : mode) : "");

export const isDangerMode = (mode: string | null) => mode === "bypassPermissions" || mode === "agent-full-access";
