// Review: a second agent reads the session's diff after each turn (read-only) and lists what it finds.
// Chosen per session from the header; the reviewer's answers open as a column at the pane's right edge, like the side chat

import { ScanSearch, RefreshCw, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { Select as SelectPrimitive } from "radix-ui";

import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { ProfileOption, ProviderLogo, profileTitle } from "../icons";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidMenu } from "../liquid/stage";
import { smooth } from "../motion";
import { Composer } from "./Composer";
import { ColumnResizer } from "./GitPane";
import { SIDE_MIN, useSideColumnWidth } from "./sideColumn";
import { Transcript } from "./Transcript";

const OFF = "__off__";

/** Header button: pick the profile that reviews this session after each turn, or none */
export function ReviewButton({ mainId }: { mainId: string }) {
  const t = useT();
  const reviewer = useStore((s) => s.sessions[mainId]?.record.reviewer ?? null);
  const profiles = useStore((s) => s.profiles);
  const menu = useLiquidMenu(`menu:review:${mainId}`, `review:${mainId}`);
  return (
    <Select value={reviewer ?? OFF} onValueChange={(v) => void api.setReviewer(mainId, v === OFF ? null : v)} onOpenChange={menu.onOpenChange}>
      {/* The bare trigger, so it looks like the header's other buttons (the styled one brings a box, a height and a chevron) */}
      <SelectPrimitive.Trigger
        ref={liquidAnchor(`review:${mainId}`)}
        aria-label={t("side.review")}
        title={reviewer ? t("side.reviewBy", { profile: reviewer }) : t("side.review")}
        className={cn(
          "flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          reviewer && "bg-accent text-foreground",
        )}
      >
        <ScanSearch className="size-3.5" aria-hidden />
      </SelectPrimitive.Trigger>
      <SelectContent
        ref={menu.ref as React.Ref<HTMLDivElement>}
        style={menu.style}
        position="popper"
        align="end"
        sideOffset={6}
        className={cn("z-[58]", menu.moving && "opacity-0")}
      >
        <SelectItem value={OFF}>{t("side.reviewOff")}</SelectItem>
        {profiles.map((p) => (
          <SelectItem key={p.name} value={p.name}>
            <ProfileOption profile={p} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ReviewColumn({ mainId, pane }: { mainId: string; pane: React.RefObject<HTMLElement | null> }) {
  const on = useStore((s) => !!s.sessions[mainId]?.record.reviewer);
  const [resizing, setResizing] = useState(false);
  const [width, setWidth, resetWidth] = useSideColumnWidth(pane, "plyfold.reviewWidth");
  return (
    <motion.div
      initial={false}
      animate={{ width: on ? width : 0 }}
      transition={resizing ? { duration: 0 } : smooth}
      inert={!on}
      className={cn("flex shrink-0 overflow-hidden", on && "border-l")}
    >
      <div style={{ width }} className="relative flex shrink-0 flex-col">
        {on && <ColumnResizer edge="left" width={width} min={SIDE_MIN} onChange={setWidth} onReset={resetWidth} onActiveChange={setResizing} />}
        {on && <ReviewBody mainId={mainId} />}
      </div>
    </motion.div>
  );
}

function ReviewBody({ mainId }: { mainId: string }) {
  const t = useT();
  const reviewer = useStore((s) => s.sessions[mainId]?.record.reviewer);
  const view = useStore((s) => Object.values(s.sessions).find((v) => v.record.review && v.record.side_of === mainId));
  const queue = useStore((s) => (view ? s.queues[view.record.id] : undefined));
  const profile = useStore((s) => s.profiles.find((p) => p.name === reviewer));
  const { sendPrompt, cancel, setCategory, enqueue, unqueue, sendQueuedNow, insertIntoComposer } = useStore.getState();
  const [error, setError] = useState<string | null>(null);
  const r = view?.record;
  // The prompts that carry the diff are long; the answers are what matters here
  const items = view?.transcript.items.filter((i) => !(i.kind === "user" && i.text.includes("~~~~diff"))) ?? [];

  // A finding goes to the reviewed session as its next instruction (queued while it is mid-turn)
  const sendBack = (review: string) => {
    const text = t("side.sendBackPrompt", { review });
    if (useStore.getState().sessions[mainId]?.transcript.inTurn) enqueue(mainId, text, []);
    else void sendPrompt(mainId, text);
  };

  const reviewNow = () => {
    setError(null);
    api.reviewNow(mainId).then(
      (id) => !id && setError(t("side.reviewNothing")),
      (e) => setError(String(e)),
    );
  };

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <ScanSearch className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("side.reviewTitle")}</span>
        {profile && <ProviderLogo agent={profile.agent} className="size-3 text-muted-foreground" />}
        <span className="truncate text-xs text-muted-foreground">{profile && profileTitle(profile)}</span>
        <span className="grow" />
        <button
          type="button"
          aria-label={t("side.reviewNow")}
          title={t("side.reviewNow")}
          disabled={!!view?.transcript.inTurn}
          onClick={reviewNow}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("side.reviewStop")}
          title={t("side.reviewStop")}
          onClick={() => void api.setReviewer(mainId, null)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {error && <p className="mx-3 mt-3 text-xs whitespace-pre-wrap text-muted-foreground">{error}</p>}
      {!view || !r ? (
        <p className="mx-3 mt-3 text-xs leading-relaxed text-muted-foreground">{t("side.reviewHint")}</p>
      ) : (
        <>
          <Transcript
            items={items}
            info={view.info}
            streaming={r.status === "working"}
            busy={view.transcript.inTurn}
            compact
            commands={view.info?.commands ?? []}
            base={r.worktree_path ?? r.repo_path ?? undefined}
            onQuote={{ label: t("side.quote"), run: (text) => insertIntoComposer(mainId, text) }}
            onSendBack={{ label: t("side.sendBack"), run: sendBack }}
          />
          <Composer
            scope={r.id}
            agent={r.agent}
            info={view.info}
            disabled={r.status === "starting"}
            busy={view.transcript.inTurn}
            placeholder={t("side.reviewPlaceholder")}
            onSend={(text, a) => (view.transcript.inTurn ? enqueue(r.id, text, a) : void sendPrompt(r.id, text, a))}
            queue={queue ?? []}
            onUnqueue={(k) => unqueue(r.id, k)}
            onSendQueued={(key) => sendQueuedNow(r.id, key)}
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
