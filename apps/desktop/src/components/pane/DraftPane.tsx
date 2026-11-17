import { ArrowDown, ArrowUp, Check, Coins, FolderOpen, GitBranch, MessageSquare, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { money, repoName, tokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { AGENT_NAMES, ProviderLogo } from "../icons";
import { ControlRow } from "./Composer";
import { AttachBox, useAttachments } from "./Attachments";
import { MentionMenu, removeMention, useMention } from "./Mention";
import { useAutoGrow } from "./autoGrow";
import { RepoPicker } from "./RepoPicker";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";
import { withChoices } from "@/state/infoCache";
import type { Category, ProfileSummary, ProfileUsage } from "@/lib/types";
import { isSendKey } from "@/lib/keys";
import { useT, type MessageKey } from "@/i18n";

/** Label for the auth type */
function authLabel(p: { keyed: boolean; custom_provider: boolean }): MessageKey {
  return p.custom_provider ? "draft.authCustom" : p.keyed ? "draft.authKeyed" : "draft.authLogin";
}

const profileName = (p: ProfileSummary) => (p.name === p.agent ? "default" : p.label);

function Num({ icon: Icon, title, children }: { icon: typeof Coins; title: string; children: React.ReactNode }) {
  return (
    <span title={title} className="flex items-center gap-[3px]">
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/** One profile row: name and auth type, plus turns, tokens and cost over the last 30 days */
function ProfileRow({ p, u, selected, onSelect }: { p: ProfileSummary; u: ProfileUsage | undefined; selected: boolean; onSelect: () => void }) {
  const t = useT();
  const tok = u?.input != null || u?.output != null ? (u.input ?? 0) + (u.output ?? 0) : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      data-profile={p.name}
      onClick={onSelect}
      className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-accent", selected && "bg-accent")}
    >
      <ProviderLogo agent={p.agent} className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 grow flex-col">
        <span className="truncate">{profileName(p)}</span>
        <span className="flex gap-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
          <span>{AGENT_NAMES[p.agent] ?? p.agent}</span>
          <span className="truncate">{t(authLabel(p))}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2.5 font-mono text-xs text-muted-foreground tabular">
        {u ? (
          <>
            <Num icon={MessageSquare} title={t("draft.turnsTitle", { turns: u.turns, sessions: u.sessions })}>
              {u.turns}
            </Num>
            {tok != null && (
              <span title={t("draft.tokensTitle", { input: tokens(u.input ?? 0), output: tokens(u.output ?? 0) })} className="hidden items-center gap-[3px] @md:flex">
                <ArrowUp className="size-3" aria-hidden />
                {tokens(u.input ?? 0)}
                <ArrowDown className="ml-1 size-3" aria-hidden />
                {tokens(u.output ?? 0)}
              </span>
            )}
            {u.cost != null && (
              <Num icon={Coins} title={t("draft.cost")}>
                {money(u.cost, u.currency ?? "USD")}
              </Num>
            )}
          </>
        ) : (
          <span title={t("draft.unused")}>—</span>
        )}
      </span>
      <Check className={cn("size-3.5 shrink-0", selected ? "text-foreground" : "invisible")} aria-hidden />
    </button>
  );
}

/**
 * New session (draft). Same screen as an existing session, with an empty transcript.
 * Profile list in the middle (with usage over the last 30 days). Above the input: repository and worktree on the left, model / effort / mode on the right
 */
export function DraftPane({ index, id }: { index: number; id: string }) {
  const t = useT();
  const draft = useStore((s) => s.drafts[id]);
  const profiles = useStore((s) => s.profiles);
  const { updateDraft, startDraft, closePane, focusPane } = useStore.getState();
  const [text, setText] = useState("");
  // A chip added with @ and its "@path" in the text are kept together: removing either removes the other
  const att = useAttachments({ onMentionRemoved: (path) => setText((cur) => removeMention(cur, path)) });
  const sendKey = useStore((s) => s.settings.send_key ?? "enter");
  const textRef = useAutoGrow(text);
  // @-mentions search the repository the session will start in
  const mention = useMention({ root: draft?.repo ?? null, text, setText, textRef, boxRef: att.boxRef, scope: id, onPick: (h) => att.addMention(h.abs, h.path) });
  useEffect(() => {
    att.syncMentions(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const [repoOpen, setRepoOpen] = useState(false);
  // The repository picker also pops out of its button and returns to it on close (same separation animation as other menus)
  const repoAnchor = `${id}:repo`;
  const repoMenu = useLiquidMenu(`menu:${repoAnchor}`, repoAnchor);
  const repoRaised = useLiquidActiveAnchors().has(repoAnchor);
  const toggleRepo = (o: boolean) => {
    repoMenu.onOpenChange(o);
    setRepoOpen(o);
  };
  const cached = useStore((s) => (draft?.profile ? s.infoCache[draft.profile] : undefined));
  const usage = useStore((s) => s.usage);
  useEffect(() => {
    void useStore.getState().loadUsage();
  }, []);
  if (!draft) return null;
  const sorted = [...profiles].sort((a, b) => Number(a.name === a.agent) - Number(b.name === b.agent) || a.name.localeCompare(b.name));
  const current = profiles.find((p) => p.name === draft.profile);
  const info = cached && draft ? withChoices(cached, draft.choices) : null;
  const choose = (c: Category, v: string) => updateDraft(id, { choices: { ...draft!.choices, [c]: v } });
  const modes = info ? (info.config.find((o) => o.category === "mode")?.choices.map((c) => c.value) ?? info.modes.map((m) => m.value)) : [];
  const mode = info ? (info.config.find((o) => o.category === "mode")?.current ?? info.current_mode) : null;
  const byProfile = new Map((usage ?? []).map((u) => [u.profile, u]));
  // Recently used first (unused ones: default profile first, then by name)
  const ordered = [...sorted].sort((a, b) => (byProfile.get(b.name)?.last_used ?? 0) - (byProfile.get(a.name)?.last_used ?? 0));
  const select = (name: string) => updateDraft(id, { profile: name, choices: {} });
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = ordered.findIndex((p) => p.name === draft.profile);
    const next = ordered[(i + (e.key === "ArrowDown" ? 1 : ordered.length - 1)) % ordered.length];
    if (next) {
      select(next.name);
      (e.currentTarget.querySelector(`[data-profile="${CSS.escape(next.name)}"]`) as HTMLElement | null)?.focus();
    }
  };
  const send = () => {
    if (draft.busy || !draft.profile) return;
    void startDraft(id, text, att.items);
  };

  return (
    <section aria-label={t("draft.paneLabel", { n: index + 1 })} onMouseDown={() => focusPane(index)} className="flex min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <Plus className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("draft.title")}</span>
        <span className="grow" />
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => closePane(index)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {/* List sits in the middle of the pane; scrolls vertically if it doesn't fit (my-auto keeps the top from being cut off) */}
      <div className="flex min-h-0 grow flex-col overflow-y-auto px-3 py-4">
      <div className="mx-auto my-auto w-full max-w-xl">
        <div className="mb-1 flex items-center justify-between px-2.5 text-xs text-muted-foreground">
          <span id={`${id}-profiles`}>{t("draft.profiles")}</span>
          <span>{t("draft.last30Days")}</span>
        </div>
        {/* Hide tokens when narrow (decided by row width) */}
        <div role="radiogroup" aria-labelledby={`${id}-profiles`} onKeyDown={onListKey} className="@container flex flex-col gap-0.5">
          {ordered.map((p) => (
            <ProfileRow key={p.name} p={p} u={byProfile.get(p.name)} selected={p.name === draft.profile} onSelect={() => select(p.name)} />
          ))}
          {profiles.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">{t("draft.noProfiles")}</p>}
        </div>
        {(draft.busy || draft.error) && (
          <div className="mt-3 px-2.5 text-xs">
            {draft.busy && <p className="text-muted-foreground">{t("draft.starting")}</p>}
            {draft.error && <p className="whitespace-pre-wrap text-error">{draft.error}</p>}
          </div>
        )}
      </div>
      </div>

      <Popover open={repoOpen} onOpenChange={toggleRepo}>
      <div className="flex shrink-0 flex-col px-3 pb-3">
      {/* The repository picker aligns with the left edge of this row + input group and opens right above it */}
      <PopoverAnchor asChild>
      <div className="flex flex-col gap-1">
        {/* If there's not enough width, model / effort / mode wrap to a second row */}
        <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-xs">
          <div className="flex items-center gap-0.5">
          <PopoverTrigger asChild>
            <button
              ref={liquidAnchor(repoAnchor)}
              type="button"
              aria-label={t("draft.repo")}
              title={draft.repo}
              className={cn("relative flex h-6 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent data-[state=open]:bg-accent", repoRaised && "z-[57]")}
            >
              <FolderOpen className="size-3 text-muted-foreground" aria-hidden />
              <span className="font-mono">{repoName(draft.repo)}</span>
            </button>
          </PopoverTrigger>

          <button
            type="button"
            aria-pressed={draft.worktree}
            onClick={() => updateDraft(id, { worktree: !draft.worktree })}
            title={draft.worktree ? t("draft.worktreeOn") : t("draft.worktreeOff")}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md border px-1.5 hover:bg-accent",
              draft.worktree ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground",
            )}
          >
            <GitBranch className="size-3" aria-hidden />
            {draft.worktree ? "worktree" : t("draft.inPlace")}
          </button>
          </div>
          <span className="grow" />
          <ControlRow scope={id} agent={current?.agent ?? ""} info={info} onSet={choose} empty={draft.profile ? t("draft.choicesAfterStart") : undefined} />
        </div>

        <MentionMenu m={mention} boxRef={att.boxRef} />
        <AttachBox att={att}>
          <textarea
            ref={textRef}
            aria-label={t("draft.firstPrompt")}
            rows={1}
            autoFocus
            value={text}
            placeholder={t("draft.firstPromptPlaceholder")}
            onChange={(e) => {
              setText(e.target.value);
              mention.syncCaret();
            }}
            onSelect={mention.syncCaret}
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return;
              if (isSendKey(e, sendKey)) {
                e.preventDefault();
                send();
              } else if (e.key === "Tab" && e.shiftKey && modes.length > 0) {
                e.preventDefault();
                const i = mode ? modes.indexOf(mode) : -1;
                choose("mode", modes[(i + 1) % modes.length]);
              }
            }}
            className="min-h-0 grow resize-none bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            aria-label={t("draft.start")}
            disabled={draft.busy || !draft.profile}
            onClick={send}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <ArrowUp className="size-3.5" aria-hidden />
          </button>
        </AttachBox>
      </div>
      </PopoverAnchor>
      </div>
      <PopoverContent
        ref={repoMenu.ref as React.Ref<HTMLDivElement>}
        style={repoMenu.style}
        side="top"
        align="start"
        sideOffset={6}
        // Don't span the full pane width (if wide, the body seems to fly far out before returning)
        className={cn("z-[58] w-[min(32rem,var(--radix-popper-anchor-width))] p-1.5", repoMenu.moving && "opacity-0")}
      >
        <RepoPicker
          value={draft.repo}
          onPick={(repo) => {
            updateDraft(id, { repo });
            toggleRepo(false);
          }}
        />
      </PopoverContent>
      </Popover>

    </section>
  );
}
