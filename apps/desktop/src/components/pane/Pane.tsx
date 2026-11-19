import { ArrowUp, GitBranch, Square, TriangleAlert, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { isImeKey } from "@/lib/keys";
import { cn } from "@/lib/utils";
import { gitPaneOf, isDraft, isFiles, isGit, isPreview, leavesShowing, useStore } from "@/state/store";
import { FilesPane } from "./FilesPane";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidRevealed } from "../liquid/stage";
import { DraftPane } from "./DraftPane";
import { PreviewPane } from "./PreviewPane";
import { GitPane } from "./GitPane";
import { withChoices } from "@/state/infoCache";
import { ProviderLogo, StatusIcon } from "../icons";
import { Keys } from "../Keys";
import { Composer } from "./Composer";
import { PermissionCard } from "./PermissionCard";
import { Transcript } from "./Transcript";
import { PaneTools } from "./PaneTools";
import { startDrag } from "./dnd";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";
import { useKeys } from "@/state/keys";
import { PlyfoldMark } from "../Logo";
import { SideChatButton, SideChatColumn } from "./SideChat";
import { unpushed, useGitInfo } from "./GitMenu";

function EmptyPane({ index }: { index: number }) {
  const t = useT();
  const newDraft = useStore((s) => s.newDraft);
  const newKeys = useKeys("newSession");
  const focusPane = useStore((s) => s.focusPane);
  const removePane = useStore((s) => s.removePane);
  // The last pane can't be removed (there is always at least one)
  const removable = useStore((s) => s.paneCount > 1);
  return (
    <PaneMenu slot={index}>
      <section
        ref={paneHeadAnchor(index)}
        aria-label={t("pane.emptyLabel", { n: index + 1 })}
        onMouseDown={() => focusPane(index)}
        className="relative flex min-w-0 flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        {removable && (
          <button
            type="button"
            aria-label={t("pane.removePane")}
            title={t("pane.removePane")}
            onClick={() => removePane(index)}
            className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
        {/* A faint mark, so an empty pane reads as part of the app rather than a blank area */}
        <PlyfoldMark className="mb-2 size-10 text-foreground/15" />
        <p>{t("pane.emptyHint")}</p>
        <button
          type="button"
          onClick={() => {
            focusPane(index);
            newDraft();
          }}
          className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent hover:text-foreground"
        >
          {t("pane.newSession")} <Keys keys={newKeys} />
        </button>
      </section>
    </PaneMenu>
  );
}

/** Hide the content while the separation animation opens it (appears once fully expanded) */
export function Pane({ index }: { index: number }) {
  const revealed = useLiquidRevealed(`pane-${index}`);
  const id = useStore((s) => s.panes[index]);
  return (
    <div className="flex min-w-0 grow transition-opacity duration-150" style={{ opacity: revealed ? 1 : 0 }}>
      {isDraft(id) ? (
        <DraftPane index={index} id={id} />
      ) : isPreview(id) ? (
        <PreviewPane index={index} id={id} />
      ) : isGit(id) ? (
        <GitPane index={index} id={id} />
      ) : isFiles(id) ? (
        <FilesPane index={index} id={id} />
      ) : (
        <SessionPane index={index} />
      )}
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
  const diffOpen = useStore((s) => !!id && leavesShowing(s, gitPaneOf(id)));
  const diffVersion = useStore((s) => s.diffVersion);
  const cached = useStore((s) => (view ? s.infoCache[view.record.profile] : undefined));
  const paneRef = useRef<HTMLElement>(null);

  const status = view?.record.status;
  // The worktree's change count: on every status change and after worktree actions, when the window comes back,
  // and every few seconds while the agent works (it edits files mid-turn)
  // An everyday conversation's folder is not a repository: no Git button, no change counts
  const inRepo = !!view?.record.repo_path && !view?.record.chat;
  const busyNow = status === "working" || status === "awaiting_permission" || status === "stalled";
  // Branch, upstream and commits (for the header button; the Git view loads its own)
  const git = useGitInfo(id && inRepo ? id : "", busyNow);
  useEffect(() => {
    if (!id || !inRepo) return;
    let alive = true;
    const refresh = () =>
      api
        .sessionDiff(id)
        .then((d) => alive && setDiffStat({ added: d.files.reduce((a, f) => a + f.added, 0), removed: d.files.reduce((a, f) => a + f.removed, 0) }))
        .catch(() => alive && setDiffStat(null));
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = busyNow ? setInterval(refresh, 5000) : undefined;
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      if (timer) clearInterval(timer);
    };
  }, [id, status, inRepo, busyNow, diffVersion]);

  if (!id || !view) return <EmptyPane index={index} />;
  const r = view.record;
  const working = r.status === "working" || r.status === "awaiting_permission" || r.status === "stalled" || r.status === "starting";
  const modelOpt = view.info?.config.find((o) => o.category === "model");
  const reported = view.info?.reported_model;
  const mismatch = reported && modelOpt?.current && !reported.toLowerCase().includes(modelOpt.current.toLowerCase());

  return (
    <section
      ref={paneRef}
      aria-label={t("pane.label", { n: index + 1, title: r.title })}
      onMouseDown={() => focusPane(index)}
      // A container, so the header can drop its tool buttons when the pane is narrow
      className={cn("@container flex min-w-0 flex-col", focused && "bg-white/[0.01]")}
    >
      {/* Drag the header to move the pane (onto another pane's edge to split, or its center to swap) */}
      {/* Right-click: split, even out, close */}
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(e) => startDrag(e, () => ({ kind: "pane", slot: index, title: r.title, agent: r.agent }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b pr-1.5 pl-3"
        >
          <StatusIcon status={r.status} chat={r.chat} />
          <PaneTitle id={id} title={r.title} />
          <span
            title={t("pane.profileTitle", { agent: r.agent, profile: r.profile })}
            className="hidden items-center gap-1 text-xs whitespace-nowrap text-muted-foreground @[22rem]:flex"
          >
            <ProviderLogo agent={r.agent} className="size-3" />
            {r.profile === r.agent ? "default" : r.profile}
          </span>
          {mismatch && (
            <span
              title={t("pane.modelMismatch", { model: modelOpt?.current ?? "" })}
              className="flex items-center gap-1 font-mono text-xs text-muted-foreground"
            >
              <TriangleAlert className="size-3.5 text-permission" aria-hidden />
              {reported}
            </span>
          )}
          <span className="grow" />
          <span className="hidden items-center gap-2 @[30rem]:flex">
            <PaneTools scope={id} items={view.transcript.items} alive={r.status !== "closed" && r.status !== "error"} />
          </span>
          {/* Git and the changes, one view: here for any session in a git repository. The Git mark, then +added −removed
              once there are changes, and the commits not pushed yet */}
          {(r.worktree_path || git.info) && (
            <button
              ref={liquidAnchor(`diff:${id}`)}
              type="button"
              aria-label={t("pane.openDiff", { branch: r.branch ?? git.info?.branch ?? "" })}
              title={t("pane.openDiff", { branch: r.branch ?? git.info?.branch ?? "" })}
              onClick={() => openDiff(id)}
              className={cn(
                "relative flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-xs hover:bg-accent",
                (diffActive || diffOpen) && "bg-accent",
                diffActive && "z-[57]",
              )}
            >
              <GitBranch className="size-3.5 text-muted-foreground" aria-hidden />
              {diffStat && diffStat.added + diffStat.removed > 0 && (
                <>
                  <span className="text-working">+{diffStat.added}</span>
                  <span className="text-error">−{diffStat.removed}</span>
                </>
              )}
              {git.info && unpushed(git.info) > 0 && (
                <span className="flex items-center text-muted-foreground" title={t("pane.gitUnpushed")}>
                  <ArrowUp className="size-3" aria-hidden />
                  {unpushed(git.info)}
                </span>
              )}
            </button>
          )}
          {/* Side chat: a read-only fork for questions that stay out of this conversation (Gemini CLI cannot fork) */}
          {r.acp_session_id && r.agent !== "gemini" && <SideChatButton mainId={id} />}
          {working && (
            <button
              type="button"
              aria-label={t("pane.stop")}
              onClick={() => void cancel(id)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
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
      </PaneMenu>

      <div className="flex min-h-0 grow">
        <div className="flex min-w-0 grow flex-col">
          <Transcript
            items={view.transcript.items}
            info={view.info}
            streaming={r.status === "working"}
            busy={view.transcript.inTurn}
            onResend={(t, a) => void sendPrompt(id, t, a)}
            base={r.worktree_path ?? r.repo_path ?? undefined}
            commands={view.info?.commands?.length ? view.info.commands : view.commands?.length ? view.commands : (cached?.commands ?? [])}
            sessionId={id}
          />

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
            noMode={!!r.chat}
            scope={id}
            agent={r.agent}
            info={(() => {
              // While not running, show the last known values (remembered for this profile) with the chosen values applied on top
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
            // Messages sent mid-turn are queued and sent later
            onSend={(t, a) => (view.transcript.inTurn ? enqueue(id, t, a) : void sendPrompt(id, t, a))}
            onStop={() => void cancel(id)}
            queue={queue ?? []}
            onUnqueue={(k) => unqueue(id, k)}
            onSendQueued={() => sendQueued(id)}
            root={r.worktree_path ?? r.repo_path}
            // The running agent's list, else the last one in this session's log, else the one remembered for the profile
            commands={view.info?.commands?.length ? view.info.commands : view.commands?.length ? view.commands : (cached?.commands ?? [])}
            onSet={(c, v) => void setCategory(id, c, v)}
          />
        </div>
        <SideChatColumn mainId={id} pane={paneRef} />
      </div>
    </section>
  );
}

/**
 * The session name in the pane header. Double-click (or focus it and press ⏎) to rename it in place:
 * ⏎ or leaving the field saves, esc cancels. Renaming here also stops the agent's title from replacing it
 */
function PaneTitle({ id, title }: { id: string; title: string }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const renameSession = useStore((s) => s.renameSession);
  const done = useRef(false);
  const save = (value: string) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const v = value.trim();
    if (v && v !== title) void renameSession(id, v);
  };
  if (editing)
    return (
      <input
        aria-label={t("pane.renameLabel")}
        defaultValue={title}
        autoFocus
        onFocus={(e) => {
          done.current = false;
          e.currentTarget.select();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isImeKey(e)) save(e.currentTarget.value);
          else if (e.key === "Escape") {
            done.current = true;
            setEditing(false);
          }
        }}
        onBlur={(e) => save(e.currentTarget.value)}
        className="h-6 min-w-0 flex-1 rounded-md bg-background px-1.5 font-medium outline outline-ring"
      />
    );
  return (
    <span
      role="button"
      tabIndex={0}
      title={t("pane.renameHint")}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !isImeKey(e)) setEditing(true);
      }}
      className="cursor-text truncate rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {title}
    </span>
  );
}
