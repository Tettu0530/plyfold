import { Square, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { ProviderLogo, StatusIcon } from "../icons";
import { spring } from "../motion";
import { Composer } from "./Composer";
import { PermissionCard } from "./PermissionCard";
import { Transcript } from "./Transcript";

function EmptyPane({ index }: { index: number }) {
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const focusPane = useStore((s) => s.focusPane);
  return (
    <section aria-label={`ペイン ${index + 1}（空き）`} className="flex min-w-0 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
      <p>サイドバーからセッションを選ぶか、新しく始めます</p>
      <button
        type="button"
        onClick={() => {
          focusPane(index);
          setNewSessionOpen(true);
        }}
        className="rounded-md px-2 py-1 hover:bg-accent hover:text-foreground"
      >
        新しいセッション <kbd className="font-mono">⌘N</kbd>
      </button>
    </section>
  );
}

export function Pane({ index }: { index: number }) {
  const id = useStore((s) => s.panes[index]);
  const view = useStore((s) => (id ? s.sessions[id] : undefined));
  const focused = useStore((s) => s.focusedPane === index);
  const { focusPane, closePane, sendPrompt, cancel, respondPermission, setCategory } = useStore.getState();
  const [diffStat, setDiffStat] = useState<{ added: number; removed: number } | null>(null);

  const status = view?.record.status;
  // ターンが終わるたびに、worktree の差分の数を取り直す
  useEffect(() => {
    if (!id || !view?.record.worktree_path || (status !== "idle" && status !== "closed")) return;
    api
      .sessionDiff(id)
      .then((d) => setDiffStat({ added: d.files.reduce((a, f) => a + f.added, 0), removed: d.files.reduce((a, f) => a + f.removed, 0) }))
      .catch(() => setDiffStat(null));
  }, [id, status, view?.record.worktree_path]);

  if (!id || !view) return <EmptyPane index={index} />;
  const r = view.record;
  const working = r.status === "working" || r.status === "awaiting_permission" || r.status === "stalled" || r.status === "starting";
  const modelOpt = view.info?.config.find((o) => o.category === "model");
  const reported = view.info?.reported_model;
  const mismatch = reported && modelOpt?.current && !reported.toLowerCase().includes(modelOpt.current.toLowerCase());

  return (
    <motion.section
      layout
      transition={spring}
      aria-label={`ペイン ${index + 1}: ${r.title}`}
      onMouseDown={() => focusPane(index)}
      className={cn("flex min-w-0 flex-col border-r last:border-r-0", focused && "bg-white/[0.01]")}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <StatusIcon status={r.status} />
        <span className="truncate font-medium">{r.title}</span>
        <span title={`${r.agent} のプロファイル ${r.profile}`} className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          <ProviderLogo agent={r.agent} className="size-3" />
          {r.profile === r.agent ? "default" : r.profile}
        </span>
        {mismatch && (
          <span title={`API が返したモデル名が、設定したモデル（${modelOpt?.current}）と違います`} className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 text-permission" aria-hidden />
            {reported}
          </span>
        )}
        <span className="grow" />
        {diffStat && diffStat.added + diffStat.removed > 0 && (
          <span title={`差分（${r.branch ?? ""}）`} className="flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-xs">
            <span className="text-working">+{diffStat.added}</span>
            <span className="text-error">−{diffStat.removed}</span>
          </span>
        )}
        {working && (
          <button type="button" aria-label="停止（⌘.）" onClick={() => void cancel(id)} className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <Square className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label="ペインを閉じる（セッションは残ります）"
          onClick={() => closePane(index)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <Transcript items={view.transcript.items} info={view.info} streaming={r.status === "working"} />

      <div className="px-5">
        <AnimatePresence>
          {view.permission && (
            <PermissionCard
              key={view.permission.permissionId}
              permission={view.permission}
              agent={r.agent}
              onRespond={(o) => void respondPermission(id, o)}
              onStop={() => void cancel(id)}
            />
          )}
        </AnimatePresence>
      </div>

      <Composer
        agent={r.agent}
        info={view.info}
        disabled={working}
        placeholder={
          r.status === "closed" || r.status === "error"
            ? "送ると、エージェントを起動し直して続けます"
            : view.permission
              ? "権限確認に答えると続きます"
              : working
                ? "作業中です（終わってから送れます）"
                : "指示を入力"
        }
        onSend={(t) => void sendPrompt(id, t)}
        onSet={(c, v) => void setCategory(id, c, v)}
      />
    </motion.section>
  );
}
