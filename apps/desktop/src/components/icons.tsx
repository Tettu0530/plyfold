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

// Official shapes from Simple Icons (CC0). OpenAI isn't included, so use a generic icon instead of drawing a fake one
const LOGO_PATHS: Record<string, string> = {
  claude:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  gemini:
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  opencode: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
};

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

export function ProviderLogo({ agent, className }: { agent: string; className?: string }) {
  const d = LOGO_PATHS[agent];
  const icon = useStore((s) => (d ? null : (s.profiles.find((p) => p.agent === agent && p.agent_icon)?.agent_icon ?? null)));
  // An icon kept from the ACP Registry: drawn as a mask, so it takes the text color like the built-in logos
  if (!d && icon) {
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
  if (!d) return <SquareTerminal aria-hidden className={cn("size-3.5 shrink-0", className)} />;
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-3.5 shrink-0", className)}>
      <path d={d} fill="currentColor" />
    </svg>
  );
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
