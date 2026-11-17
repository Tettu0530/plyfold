import { Shield } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import type { PendingPermission } from "@/state/transcript";
import { Keys } from "../Keys";
import { dropIn } from "../motion";
import { isImeKey } from "@/lib/keys";
import { useT } from "@/i18n";
import { useKeys } from "@/state/keys";

/** Whether "reject" ends the turn differs by agent (docs/probe-findings.md) */
const REJECT_ENDS_TURN = new Set(["codex"]);

export function PermissionCard({
  permission,
  agent,
  onRespond,
  onStop,
}: {
  permission: PendingPermission;
  agent: string;
  onRespond: (optionId: string | null) => void;
  onStop: () => void;
}) {
  const t = useT();
  const stopKeys = useKeys("stop");
  const once = permission.options.find((o) => o.kind === "allow_once");
  const always = permission.options.find((o) => o.kind === "allow_always");
  const reject = permission.options.find((o) => o.kind.startsWith("reject"));
  const command = (permission.toolCall.rawInput as { command?: string } | undefined)?.command;

  return (
    <motion.div {...dropIn} style={{ transformOrigin: "12px 0" }} role="alertdialog" aria-label={t("permission.label")}>
      <div
        className="flex flex-col gap-2.5 rounded-xl border border-permission/35 bg-card/80 p-3 shadow-[0_8px_24px_rgba(0,0,0,.45),inset_0_1px_0_rgba(255,255,255,.06)] backdrop-blur-xl backdrop-saturate-150"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isImeKey(e) && once) onRespond(once.option_id);
        }}
      >
        <div className="flex items-center gap-2">
          <Shield className="size-4 text-permission" aria-hidden />
          <span className="font-medium">{permission.title || t("permission.defaultTitle")}</span>
        </div>
        {command && <code className="block rounded-lg bg-background px-2.5 py-1.5 font-mono text-xs leading-relaxed">{command}</code>}
        <div className="flex flex-wrap items-center gap-1.5">
          {once && (
            <Button size="sm" autoFocus onClick={() => onRespond(once.option_id)} className="h-7 gap-1.5 px-2.5">
              {t("permission.allowOnce")}<Keys keys={["enter"]} onPrimary />
            </Button>
          )}
          {always && (
            <Button size="sm" variant="outline" onClick={() => onRespond(always.option_id)} className="h-7 px-2.5">
              {t("permission.allowAlways")}
            </Button>
          )}
          {reject && (
            <Button size="sm" variant="outline" onClick={() => onRespond(reject.option_id)} className="h-7 px-2.5">
              {REJECT_ENDS_TURN.has(agent) ? t("permission.denyAndEndTurn") : t("permission.deny")}
            </Button>
          )}
          <span className="grow" />
          <Button size="sm" variant="ghost" onClick={onStop} className="h-7 gap-1.5 px-2 text-error hover:text-error">
            {t("permission.stop")}
            <Keys keys={stopKeys} />
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
