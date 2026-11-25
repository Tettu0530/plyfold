// The side chat: a read-only fork of the session beside it, for questions that should not enter the main conversation.
// It opens as a column at the pane's right edge (its width springs, so the main conversation reflows rather than scales)

import { MessageCircleQuestionMark, Trash2, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { smooth } from "../motion";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { Spinner } from "../icons";

/** The column's width: about 40% of the pane, between 280 and 420 px */
function useColumnWidth(pane: React.RefObject<HTMLElement | null>) {
  const [w, setW] = useState(340);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => setW(Math.round(Math.min(420, Math.max(280, el.clientWidth * 0.4))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pane]);
  return w;
}

/** "Forked n min ago", refreshed every half minute */
function useAge(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((now - since) / 60_000));
}

export function SideChatButton({ mainId, className }: { mainId: string; className?: string }) {
  const t = useT();
  const open = useStore((s) => !!s.sideChats[mainId]);
  const openSideChat = useStore((s) => s.openSideChat);
  const insert = useStore((s) => s.insertIntoComposer);
  const sideId = useStore((s) => s.sideChats[mainId]?.id);
  return (
    <button
      type="button"
      aria-label={t("side.open")}
      title={t("side.open")}
      aria-pressed={open}
      onClick={() => (open ? sideId && insert(sideId, "") : void openSideChat(mainId))}
      className={cn(
        "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        open && "bg-accent text-foreground",
        className,
      )}
    >
      <MessageCircleQuestionMark className="size-3.5" aria-hidden />
    </button>
  );
}

export function SideChatColumn({ mainId, pane }: { mainId: string; pane: React.RefObject<HTMLElement | null> }) {
  const side = useStore((s) => s.sideChats[mainId]);
  const width = useColumnWidth(pane);
  return (
    <motion.div
      initial={false}
      animate={{ width: side ? width : 0 }}
      transition={smooth}
      inert={!side}
      className={cn("flex shrink-0 overflow-hidden", side && "border-l")}
    >
      {/* Keeps its own width while the column opens and closes, so its text never reflows */}
      <div style={{ width }} className="flex shrink-0 flex-col">
        {side && <SideChatBody mainId={mainId} />}
      </div>
    </motion.div>
  );
}

function SideChatBody({ mainId }: { mainId: string }) {
  const t = useT();
  const side = useStore((s) => s.sideChats[mainId]);
  const view = useStore((s) => (side?.id ? s.sessions[side.id] : undefined));
  const queue = useStore((s) => (side?.id ? s.queues[side.id] : undefined));
  const { closeSideChat, refreshSideChat, sendPrompt, cancel, setCategory, insertIntoComposer, enqueue, unqueue, sendQueued } = useStore.getState();
  const age = useAge(side?.openedAt ?? Date.now());
  const focused = useRef<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Put the cursor in the side chat's input once it is ready
  useEffect(() => {
    if (side?.id && focused.current !== side.id) {
      focused.current = side.id;
      insertIntoComposer(side.id, "");
    }
  }, [side?.id, insertIntoComposer]);

  if (!side) return null;
  const r = view?.record;
  const asked = !!view?.transcript.items.some((i) => i.kind === "user");
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <MessageCircleQuestionMark className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("side.title")}</span>
        <span className="truncate text-xs text-muted-foreground">{age === 0 ? t("side.forkedNow") : t("side.forkedAgo", { n: age })}</span>
        <span className="grow" />
        <button
          type="button"
          aria-label={t("side.clear")}
          title={t("side.clear")}
          disabled={!side.id || clearing}
          onClick={() => setConfirmClear(true)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("side.close")}
          title={t("side.close")}
          disabled={clearing}
          onClick={() => void closeSideChat(mainId)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {confirmClear && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <span className="grow">{t("side.clearConfirm")}</span>
          <button type="button" disabled={clearing} onClick={() => setConfirmClear(false)} className="rounded-md px-2 py-1 hover:bg-accent disabled:opacity-40">
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              void refreshSideChat(mainId).finally(() => {
                setClearing(false);
                setConfirmClear(false);
              });
            }}
            className="rounded-md px-2 py-1 text-error hover:bg-error/10 disabled:opacity-40"
          >
            {t("side.clear")}
          </button>
        </div>
      )}
      {side.error ? (
        <p className="m-3 text-xs whitespace-pre-wrap text-error">{side.error}</p>
      ) : !view || !r ? (
        <p className="m-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" aria-hidden />
          {t("side.starting")}
        </p>
      ) : (
        <>
          {!asked && <p className="mx-3 mt-3 text-xs leading-relaxed text-muted-foreground">{t("side.hint")}</p>}
          <Transcript
            items={view.transcript.items}
            info={view.info}
            streaming={r.status === "working"}
            busy={view.transcript.inTurn}
            compact
            commands={view.info?.commands ?? []}
            base={r.worktree_path ?? r.repo_path ?? undefined}
            onQuote={{ label: t("side.quote"), run: (text) => insertIntoComposer(mainId, text) }}
          />
          <Composer
            scope={r.id}
            agent={r.agent}
            info={view.info}
            disabled={r.status === "starting"}
            busy={view.transcript.inTurn}
            placeholder={t("side.placeholder")}
            // Mid-turn, a question waits in the queue like in the main pane
            onSend={(text, a) => (view.transcript.inTurn ? enqueue(r.id, text, a) : void sendPrompt(r.id, text, a))}
            queue={queue ?? []}
            onUnqueue={(k) => unqueue(r.id, k)}
            onSendQueued={() => sendQueued(r.id)}
            onStop={() => void cancel(r.id)}
            root={r.worktree_path ?? r.repo_path}
            commands={view.info?.commands ?? []}
            noPickers
            onSet={(c, v) => void setCategory(r.id, c, v)}
          />
        </>
      )}
    </>
  );
}
