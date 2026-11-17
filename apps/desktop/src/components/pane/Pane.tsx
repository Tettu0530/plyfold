import { Square, TriangleAlert, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isDraft, useStore } from "@/state/store";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidRevealed } from "../liquid/stage";
import { DraftPane } from "./DraftPane";
import { withChoices } from "@/state/infoCache";
import { ProviderLogo, StatusIcon } from "../icons";
import { Keys } from "../Keys";
import { Composer } from "./Composer";
import { PermissionCard } from "./PermissionCard";
import { Transcript } from "./Transcript";
import { PaneTools } from "./PaneTools";

function EmptyPane({ index }: { index: number }) {
  const t = useT();
  const newDraft = useStore((s) => s.newDraft);
  const focusPane = useStore((s) => s.focusPane);
  return (
    <section aria-label={t("pane.emptyLabel", { n: index + 1 })} className="flex min-w-0 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
      <p>{t("pane.emptyHint")}</p>
      <button
        type="button"
        onClick={() => {
          focusPane(index);
          newDraft();
        }}
        className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent hover:text-foreground"
      >
        {t("pane.newSession")} <Keys keys={["cmd", "n"]} />
      </button>
    </section>
  );
}

/** 分離アニメーションで開いているあいだは中身を隠す（広がりきってから現れる） */
export function Pane({ index }: { index: number }) {
  const revealed = useLiquidRevealed(`pane-${index}`);
  const id = useStore((s) => s.panes[index]);
  return (
    <div className="flex min-w-0 grow transition-opacity duration-150" style={{ opacity: revealed ? 1 : 0 }}>
      {isDraft(id) ? <DraftPane index={index} id={id} /> : <SessionPane index={index} />}
    </div>
  );
}

function SessionPane({ index }: { index: number }) {
  const t = useT();
  const id = useStore((s) => s.panes[index]);
  const view = useStore((s) => (id ? s.sessions[id] : undefined));
  const focused = useStore((s) => s.focusedPane === index);
  const { focusPane, closePane, sendPrompt, cancel, respondPermission, setCategory, enqueue, unqueue, sendQueued } = useStore.getState();
  const queue = useStore((s) => (id ? s.queues[id] : undefined));
  const [diffStat, setDiffStat] = useState<{ added: number; removed: number } | null>(null);
  const openDiff = useStore((s) => s.openDiff);
  const diffActive = useLiquidActiveAnchors().has(`diff:${id}`);
  const diffOpen = useStore((s) => s.diff?.id === id);
  const diffVersion = useStore((s) => s.diffVersion);
  const cached = useStore((s) => (view ? s.infoCache[view.record.profile] : undefined));

  const status = view?.record.status;
  // ターンが終わるたびに、worktree の差分の数を取り直す
  useEffect(() => {
    if (!id || !view?.record.worktree_path || (status !== "idle" && status !== "closed")) return;
    api
      .sessionDiff(id)
      .then((d) => setDiffStat({ added: d.files.reduce((a, f) => a + f.added, 0), removed: d.files.reduce((a, f) => a + f.removed, 0) }))
      .catch(() => setDiffStat(null));
  }, [id, status, view?.record.worktree_path, diffVersion]);

  if (!id || !view) return <EmptyPane index={index} />;
  const r = view.record;
  const working = r.status === "working" || r.status === "awaiting_permission" || r.status === "stalled" || r.status === "starting";
  const modelOpt = view.info?.config.find((o) => o.category === "model");
  const reported = view.info?.reported_model;
  const mismatch = reported && modelOpt?.current && !reported.toLowerCase().includes(modelOpt.current.toLowerCase());

  return (
    <section
      aria-label={t("pane.label", { n: index + 1, title: r.title })}
      onMouseDown={() => focusPane(index)}
      className={cn("flex min-w-0 flex-col", focused && "bg-white/[0.01]")}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <StatusIcon status={r.status} />
        <span className="truncate font-medium">{r.title}</span>
        <span title={t("pane.profileTitle", { agent: r.agent, profile: r.profile })} className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          <ProviderLogo agent={r.agent} className="size-3" />
          {r.profile === r.agent ? "default" : r.profile}
        </span>
        {mismatch && (
          <span title={t("pane.modelMismatch", { model: modelOpt?.current ?? "" })} className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <TriangleAlert className="size-3.5 text-permission" aria-hidden />
            {reported}
          </span>
        )}
        <span className="grow" />
        <PaneTools scope={id} items={view.transcript.items} worktree={r.worktree_path ?? r.repo_path} alive={r.status !== "closed" && r.status !== "error"} />
        {diffStat && diffStat.added + diffStat.removed > 0 && (
          <button
            ref={liquidAnchor(`diff:${id}`)}
            type="button"
            title={t("pane.openDiff", { branch: r.branch ?? "" })}
            onClick={() => openDiff(id)}
            className={cn(
              "relative flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-xs hover:bg-accent",
              (diffActive || diffOpen) && "bg-accent",
              diffActive && "z-[57]",
            )}
          >
            <span className="text-working">+{diffStat.added}</span>
            <span className="text-error">−{diffStat.removed}</span>
          </button>
        )}
        {working && (
          <button type="button" aria-label={t("pane.stop")} onClick={() => void cancel(id)} className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <Square className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label={t("pane.closePane")}
          onClick={() => closePane(index)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <Transcript items={view.transcript.items} info={view.info} streaming={r.status === "working"} busy={view.transcript.inTurn} onResend={(t, a) => void sendPrompt(id, t, a)} />

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
        scope={id}
        agent={r.agent}
        info={(() => {
          // 動いていないあいだは、前回の値（このプロファイルで覚えているもの）に、選んでおいた値を重ねて出す
          const base = r.status === "closed" || r.status === "error" || r.status === "starting" ? (view.info ?? cached ?? null) : view.info;
          return base && Object.keys(view.pending).length > 0 ? withChoices(base, view.pending) : base;
        })()}
        disabled={r.status === "starting"}
        busy={view.transcript.inTurn}
        placeholder={
          r.status === "closed" || r.status === "error"
            ? t("pane.placeholderRestart")
            : view.permission
              ? t("pane.placeholderPermission")
              : view.transcript.inTurn
                ? t("pane.placeholderWorking")
                : t("pane.placeholder")
        }
        // ターンの途中に送ったものは、キューに積んで後で送る
        onSend={(t, a) => (view.transcript.inTurn ? enqueue(id, t, a) : void sendPrompt(id, t, a))}
        onStop={() => void cancel(id)}
        queue={queue ?? []}
        onUnqueue={(k) => unqueue(id, k)}
        onSendQueued={() => sendQueued(id)}
        onSet={(c, v) => void setCategory(id, c, v)}
      />
    </section>
  );
}
