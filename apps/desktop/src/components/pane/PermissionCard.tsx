import { Shield } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import type { PendingPermission } from "@/state/transcript";
import { Keys } from "../Keys";
import { dropIn } from "../motion";
import { isImeKey } from "@/lib/keys";

/** エージェントによって「拒否」でターンが終わるかが違う（docs/probe-findings.md） */
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
  const once = permission.options.find((o) => o.kind === "allow_once");
  const always = permission.options.find((o) => o.kind === "allow_always");
  const reject = permission.options.find((o) => o.kind.startsWith("reject"));
  const command = (permission.toolCall.rawInput as { command?: string } | undefined)?.command;

  return (
    <motion.div {...dropIn} style={{ transformOrigin: "12px 0" }} role="alertdialog" aria-label="権限確認">
      <div
        className="flex flex-col gap-2.5 rounded-xl border border-permission/35 bg-card/80 p-3 shadow-[0_8px_24px_rgba(0,0,0,.45),inset_0_1px_0_rgba(255,255,255,.06)] backdrop-blur-xl backdrop-saturate-150"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isImeKey(e) && once) onRespond(once.option_id);
        }}
      >
        <div className="flex items-center gap-2">
          <Shield className="size-4 text-permission" aria-hidden />
          <span className="font-medium">{permission.title || "ツールを実行してよいですか"}</span>
        </div>
        {command && <code className="block rounded-lg bg-background px-2.5 py-1.5 font-mono text-xs leading-relaxed">{command}</code>}
        <div className="flex flex-wrap items-center gap-1.5">
          {once && (
            <Button size="sm" autoFocus onClick={() => onRespond(once.option_id)} className="h-7 gap-1.5 px-2.5">
              今回だけ許可<Keys keys={["enter"]} onPrimary />
            </Button>
          )}
          {always && (
            <Button size="sm" variant="outline" onClick={() => onRespond(always.option_id)} className="h-7 px-2.5">
              常に許可
            </Button>
          )}
          {reject && (
            <Button size="sm" variant="outline" onClick={() => onRespond(reject.option_id)} className="h-7 px-2.5">
              {REJECT_ENDS_TURN.has(agent) ? "拒否してターンを終える" : "拒否"}
            </Button>
          )}
          <span className="grow" />
          <Button size="sm" variant="ghost" onClick={onStop} className="h-7 gap-1.5 px-2 text-error hover:text-error">
            停止
            <Keys keys={["cmd", "."]} />
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
