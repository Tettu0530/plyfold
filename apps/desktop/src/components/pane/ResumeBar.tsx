// A prompt waiting for a usage limit to lift (Settings → Sessions → Resume when a limit lifts): when it goes out, and
// buttons to send it now or drop it

import { Clock, Play, X } from "lucide-react";
import { motion } from "motion/react";

import { currentLang, useT } from "@/i18n";
import { api } from "@/lib/api";
import { useStore } from "@/state/store";
import { smooth } from "../motion";

export function ResumeBar({ id }: { id: string }) {
  const t = useT();
  const at = useStore((s) => s.resumes[id]);
  if (!at) return null;
  const when = new Date(at).toLocaleString(currentLang(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    // As wide as the composer below it
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={smooth} className="px-[max(0.75rem,calc((100%_-_53rem)/2))] pb-2">
      <div className="flex items-center gap-2 rounded-[10px] border px-3 py-2 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 grow tabular">{t("pane.resumeAt", { when })}</span>
        <button
          type="button"
          onClick={() => void api.resumeNow(id)}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 hover:bg-accent hover:text-foreground"
        >
          <Play className="size-3" aria-hidden />
          {t("pane.resumeNow")}
        </button>
        <button
          type="button"
          aria-label={t("pane.resumeCancel")}
          title={t("pane.resumeCancel")}
          onClick={() => void api.cancelResume(id)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </motion.div>
  );
}
