import { ArrowDown, ArrowUp, Check, Code2, Coins, FolderOpen, GitBranch, ListPlus, MessageSquare, Plus, Repeat2, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { money, repoName, tokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { COMPARE_MAX, modeIds, useIsGitFolder, useStore } from "@/state/store";
import { agentName, profileTitle, ProviderLogo } from "../icons";
import { ControlRow } from "./Composer";
import { AttachBox, useAttachments } from "./Attachments";
import { MentionMenu, removeMention, useMention } from "./Mention";
import { SlashMenu, useSlash } from "./Slash";
import { useAutoGrow } from "./autoGrow";
import { RepoPicker } from "./RepoPicker";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";
import { withChoices } from "@/state/infoCache";
import type { Category, ProfileSummary, ProfileUsage } from "@/lib/types";
import { api } from "@/lib/api";
import type { CliSession } from "@/lib/types";
import { isSendKey } from "@/lib/keys";
import { useT, type MessageKey } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CHIP_TRIGGER, COMPOSER_PRIMARY_BUTTON } from "./chip";
import { startDrag } from "./dnd";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";

function StartModeIcon({ mode }: { mode: "conversation" | "coding" | "parallel" | "continue" }) {
  const Icon = mode === "conversation" ? MessageSquare : mode === "coding" ? Code2 : mode === "parallel" ? Sparkles : Repeat2;
  return <Icon className="size-3.5 text-muted-foreground" aria-hidden />;
}

function authLabel(p: { keyed: boolean; custom_provider: boolean }): MessageKey {
  return p.custom_provider ? "draft.authCustom" : p.keyed ? "draft.authKeyed" : "draft.authLogin";
}

function Num({ icon: Icon, title, children }: { icon: typeof Coins; title: string; children: React.ReactNode }) {
  return (
    <span title={title} className="flex items-center gap-[3px]">
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/** One profile row: name and auth type, plus turns, tokens and cost over the last 30 days */
function ProfileRow({
  p,
  u,
  selected,
  multi,
  onSelect,
}: {
  p: ProfileSummary;
  u: ProfileUsage | undefined;
  selected: boolean;
  /** Several can be picked (comparing): a checkbox rather than a radio */
  multi?: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const tok = u?.input != null || u?.output != null ? (u.input ?? 0) + (u.output ?? 0) : null;
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      tabIndex={selected || multi ? 0 : -1}
      data-profile={p.name}
      onClick={onSelect}
      className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-accent", selected && "bg-accent")}
    >
      <ProviderLogo agent={p.agent} className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 grow flex-col">
        <span className="truncate">{profileTitle(p)}</span>
        <span className="flex gap-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
          {p.name !== p.agent && <span>{agentName(p.agent)}</span>}
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
              <span
                title={t("draft.tokensTitle", { input: tokens(u.input ?? 0), output: tokens(u.output ?? 0) })}
                className="hidden items-center gap-[3px] @md:flex"
              >
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
  const { updateDraft, startDraft, startCompare, queueTask, closePane, focusPane } = useStore.getState();
  const waiting = useStore((s) => s.tasks.length);
  // Shown for a moment after a prompt went into the queue
  const [queued, setQueued] = useState(false);
  const [text, setText] = useState(draft?.retryInput?.text ?? "");
  // A chip added with @ and its "@path" in the text are kept together: removing either removes the other
  const att = useAttachments({
    scope: id,
    initialItems: draft?.retryInput?.attachments,
    onMentionRemoved: (path) => setText((cur) => removeMention(cur, path)),
  });
  const sendKey = useStore((s) => s.settings.send_key ?? "enter");
  const textRef = useAutoGrow(text);
  // @-mentions search the repository the session will start in
  const mention = useMention({
    root: draft?.repo ?? null,
    text,
    setText,
    textRef,
    boxRef: att.boxRef,
    scope: id,
    onPick: (h) => att.addMention(h.abs, h.path),
  });
  useEffect(() => {
    att.syncMentions(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const [repoOpen, setRepoOpen] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const [startKind, setStartKind] = useState<"conversation" | "coding" | "parallel" | "continue">(draft?.chat ? "conversation" : "coding");
  const isGit = useIsGitFolder(draft?.repo);
  // A folder that is not a git repository has no worktree to work in, and nothing to compare runs in
  useEffect(() => {
    if (isGit || !draft) return;
    if (draft.worktree || draft.compare) updateDraft(id, { worktree: false, compare: null });
    if (startKind === "parallel") setStartKind("coding");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGit, draft?.worktree, draft?.compare, startKind]);
  const repoAnchor = `${id}:repo`;
  const repoMenu = useLiquidMenu(`menu:${repoAnchor}`, repoAnchor);
  const repoRaised = useLiquidActiveAnchors().has(repoAnchor);
  const modeAnchor = `${id}:start-mode`;
  const modeMenu = useLiquidMenu(`menu:${modeAnchor}`, modeAnchor);
  const modeRaised = useLiquidActiveAnchors().has(modeAnchor);
  const toggleRepo = (o: boolean) => {
    repoMenu.onOpenChange(o);
    setRepoOpen(o);
  };
  const cached = useStore((s) => (draft?.profile ? s.infoCache[draft.profile] : undefined));
  const savedEffort = useStore((s) => (draft?.profile ? s.effort.profiles[draft.profile] : undefined));
  const usage = useStore((s) => s.usage);
  const settingMode = useStore((s) => s.settings.default_mode);
  useEffect(() => {
    void useStore.getState().loadUsage();
  }, []);
  // "/" at the start lists the agent's slash commands (remembered from the profile's last session)
  const slash = useSlash({ commands: cached?.commands ?? [], text, setText, textRef, boxRef: att.boxRef, scope: id });
  if (!draft) return null;
  const sorted = [...profiles].sort((a, b) => Number(a.name === a.agent) - Number(b.name === b.agent) || a.name.localeCompare(b.name));
  const current = profiles.find((p) => p.name === draft.profile);
  const preferredEffort = draft.choices.thought_level ?? savedEffort;
  const hasEffort = cached?.config.some((option) => option.category === "thought_level" && option.choices.some((choice) => choice.value === preferredEffort));
  // The mode from Settings shows here too (when this agent has it), so the chip says what the session will start in
  const startMode = !draft.chat && draft.choices.mode === undefined && settingMode && modeIds(cached).includes(settingMode) ? { mode: settingMode } : {};
  const info = cached ? withChoices(cached, { ...startMode, ...(hasEffort ? { ...draft.choices, thought_level: preferredEffort } : draft.choices) }) : null;
  const choose = (c: Category, v: string) => updateDraft(id, { choices: { ...draft!.choices, [c]: v } });
  const modes = info ? (info.config.find((o) => o.category === "mode")?.choices.map((c) => c.value) ?? info.modes.map((m) => m.value)) : [];
  const mode = info ? (info.config.find((o) => o.category === "mode")?.current ?? info.current_mode) : null;
  const byProfile = new Map((usage ?? []).map((u) => [u.profile, u]));
  // Recently used first (unused ones: default profile first, then by name)
  const ordered = [...sorted].sort((a, b) => (byProfile.get(b.name)?.last_used ?? 0) - (byProfile.get(a.name)?.last_used ?? 0));
  const picks = draft.compare ?? null;
  const activePicks = startKind === "parallel" ? picks : null;
  const continueMode = startKind === "continue";
  // Comparing: each click adds or removes a profile (up to COMPARE_MAX); the first picked drives the controls below
  const select = (name: string) => {
    if (!activePicks) return updateDraft(id, { profile: name, choices: {} });
    const next = activePicks.includes(name) ? activePicks.filter((n) => n !== name) : activePicks.length < COMPARE_MAX ? [...activePicks, name] : activePicks;
    updateDraft(id, { compare: next, profile: next[0] ?? null, choices: {} });
  };
  const canStart = !draft.busy && (activePicks ? activePicks.length >= 2 : !!draft.profile) && (!continueMode || current?.agent !== "gemini");
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
    if (!canStart || continueMode) return;
    void (activePicks ? startCompare(id, text, att.items) : startDraft(id, text, att.items));
  };

  return (
    <section aria-label={t("draft.paneLabel", { n: index + 1 })} onMouseDown={() => focusPane(index)} className="flex min-w-0 flex-col">
      {/* Right-click: split, even out, close */}
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(e) => startDrag(e, () => ({ kind: "pane", slot: index, title: t("draft.title") }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b pr-1.5 pl-3"
        >
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
      </PaneMenu>

      {/* List sits in the middle of the pane; scrolls vertically if it doesn't fit (my-auto keeps the top from being cut off) */}
      <div className="flex min-h-0 grow flex-col overflow-y-auto px-3 py-4">
        <div className="mx-auto my-auto w-full max-w-xl">
          <div className="mb-1 flex items-center justify-between px-2.5 text-xs text-muted-foreground">
            <span id={`${id}-profiles`}>{picks ? t("draft.compareProfiles", { count: picks.length, max: COMPARE_MAX }) : t("draft.profiles")}</span>
            <span>{t("draft.last30Days")}</span>
          </div>
          {/* Hide tokens when narrow (decided by row width) */}
          <div
            role={picks ? "group" : "radiogroup"}
            aria-labelledby={`${id}-profiles`}
            onKeyDown={picks ? undefined : onListKey}
            className="@container flex flex-col gap-0.5"
          >
            {ordered.map((p) => (
              <ProfileRow
                key={p.name}
                p={p}
                u={byProfile.get(p.name)}
                selected={picks ? picks.includes(p.name) : p.name === draft.profile}
                multi={!!picks}
                onSelect={() => select(p.name)}
              />
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
        <PopoverAnchor asChild>
          <div className="flex shrink-0 flex-col px-[max(0.75rem,calc((100%_-_53rem)/2))] pb-3">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-xs">
                <Select
                  value={startKind}
                  onOpenChange={modeMenu.onOpenChange}
                  onValueChange={(value) => {
                    const next = value as typeof startKind;
                    setStartKind(next);
                    updateDraft(id, {
                      chat: next === "conversation",
                      compare: next === "parallel" ? (picks ?? (draft.profile ? [draft.profile] : [])) : null,
                    });
                    setContinueOpen(next === "continue");
                  }}
                >
                  <SelectTrigger
                    ref={liquidAnchor(modeAnchor)}
                    aria-label={t("draft.startMode")}
                    className={cn(CHIP_TRIGGER, "relative w-fit border border-transparent", "data-[state=open]:bg-accent", modeRaised && "z-[57]")}
                  >
                    <SelectValue>
                      <span className="flex items-center gap-1.5">
                        <StartModeIcon mode={startKind} />
                        {t(`draft.mode${startKind[0].toUpperCase()}${startKind.slice(1)}` as MessageKey)}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    ref={modeMenu.ref as React.Ref<HTMLDivElement>}
                    style={modeMenu.style}
                    position="popper"
                    side="top"
                    align="start"
                    className={cn("z-[58] min-w-52 p-1", modeMenu.moving && "opacity-0")}
                  >
                    {(["conversation", "coding", "parallel", "continue"] as const).map((value) => (
                      <SelectItem key={value} value={value} disabled={value === "parallel" && !isGit} className="h-8 text-xs">
                        <StartModeIcon mode={value} />
                        {t(`draft.mode${value[0].toUpperCase()}${value.slice(1)}` as MessageKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {startKind !== "conversation" && (
                  <PopoverTrigger asChild>
                    <button
                      ref={liquidAnchor(repoAnchor)}
                      type="button"
                      aria-label={t("draft.repo")}
                      title={draft.repo}
                      className={cn("relative flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-accent", repoRaised && "z-[57]")}
                    >
                      <FolderOpen className="size-3 text-muted-foreground" aria-hidden />
                      <span className="font-mono">{repoName(draft.repo)}</span>
                      <GitBranch className="size-3 text-muted-foreground" aria-hidden />
                      <span className="text-muted-foreground">{draft.worktree || activePicks ? t("draft.worktree") : t("draft.inPlace")}</span>
                    </button>
                  </PopoverTrigger>
                )}
                {startKind === "conversation" && <span className="px-2 text-muted-foreground">{t("draft.chat")}</span>}
                {continueMode && current?.agent !== "gemini" && draft.profile && (
                  <CliSessions
                    key={`${draft.profile}:${draft.repo}`}
                    draftId={id}
                    profile={draft.profile}
                    repo={draft.repo}
                    busy={draft.busy}
                    open={continueOpen}
                    onOpenChange={setContinueOpen}
                  />
                )}
                <span className="grow" />
                <ControlRow
                  scope={id}
                  agent={current?.agent ?? ""}
                  info={info}
                  onSet={choose}
                  noMode={startKind === "conversation"}
                  showContext={false}
                  empty={draft.profile ? t("draft.choicesAfterStart") : undefined}
                />
              </div>
              <MentionMenu m={mention} boxRef={att.boxRef} />
              <SlashMenu m={slash} boxRef={att.boxRef} />
              <AttachBox att={att}>
                <textarea
                  ref={textRef}
                  aria-label={t("draft.firstPrompt")}
                  rows={1}
                  autoFocus
                  value={text}
                  placeholder={
                    startKind === "conversation" ? t("draft.chatPlaceholder") : continueMode ? t("draft.chooseSession") : t("draft.firstPromptPlaceholder")
                  }
                  onChange={(e) => {
                    setText(e.target.value);
                    mention.syncCaret();
                    slash.syncCaret();
                  }}
                  onSelect={() => {
                    mention.syncCaret();
                    slash.syncCaret();
                  }}
                  onKeyDown={(e) => {
                    if (mention.onKeyDown(e) || slash.onKeyDown(e)) return;
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
                {!draft.chat && !activePicks && !continueMode && (
                  <button
                    type="button"
                    aria-label={t("draft.queue")}
                    title={t("draft.queueHint", { count: waiting })}
                    disabled={!canStart || !text.trim()}
                    onClick={() =>
                      void queueTask(id, text).then(() => {
                        setText("");
                        setQueued(true);
                        setTimeout(() => setQueued(false), 2000);
                      })
                    }
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    {queued ? <Check className="size-3.5" aria-hidden /> : <ListPlus className="size-3.5" aria-hidden />}
                  </button>
                )}
                <button type="button" aria-label={t("draft.start")} disabled={!canStart} onClick={send} className={COMPOSER_PRIMARY_BUTTON}>
                  <ArrowUp className="size-3.5" aria-hidden />
                </button>
              </AttachBox>
            </div>
          </div>
        </PopoverAnchor>
        <PopoverContent
          ref={repoMenu.ref as React.Ref<HTMLDivElement>}
          style={repoMenu.style}
          side="top"
          align="start"
          sideOffset={6}
          className={cn("z-[58] w-[min(32rem,var(--radix-popper-anchor-width))] p-1.5", repoMenu.moving && "opacity-0")}
        >
          <div className="flex flex-col gap-1">
            <RepoPicker value={draft.repo} onPick={(repo) => updateDraft(id, { repo })} />
            {!isGit && <p className="border-t border-border px-2 py-1 text-xs text-muted-foreground">{t("draft.notGit")}</p>}
            {startKind === "parallel" && <p className="border-t border-border px-2 py-1 text-xs text-muted-foreground">{t("draft.compareWorktree")}</p>}
            {(startKind === "coding" || continueMode) && isGit && (
              <div className="flex items-center gap-2 border-t border-border pt-1">
                <span className="px-2 text-xs text-muted-foreground">{t("draft.workspaceMode")}</span>
                <button
                  type="button"
                  aria-pressed={draft.worktree}
                  onClick={() => updateDraft(id, { worktree: true })}
                  className={cn("h-7 rounded-md px-2 text-xs", draft.worktree ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}
                >
                  {t("draft.worktree")}
                </button>
                <button
                  type="button"
                  aria-pressed={!draft.worktree}
                  onClick={() => updateDraft(id, { worktree: false })}
                  className={cn("h-7 rounded-md px-2 text-xs", !draft.worktree ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}
                >
                  {t("draft.inPlace")}
                </button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </section>
  );
}

/** Conversations this CLI already has in the chosen repository. Gemini does not advertise session/list. */
function CliSessions({
  draftId,
  profile,
  repo,
  busy,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: {
  draftId: string;
  profile: string;
  repo: string;
  busy: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => {
    if (controlledOnOpenChange) controlledOnOpenChange(value);
    else setLocalOpen(value);
  };
  const [loading, setLoading] = useState(open);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<CliSession[]>([]);
  const anchor = `${draftId}:cli`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  const raised = useLiquidActiveAnchors().has(anchor);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void api.listCliSessions(profile, repo).then(
      (rows) => {
        if (!current) return;
        setItems(rows);
        setLoading(false);
      },
      (e: unknown) => {
        if (!current) return;
        setError(String(e));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [open, profile, repo]);

  const toggle = (value: boolean) => {
    menu.onOpenChange(value);
    if (value) {
      setLoading(true);
      setError(null);
      setItems([]);
    }
    setOpen(value);
  };
  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button
          ref={liquidAnchor(anchor)}
          type="button"
          disabled={busy || !repo}
          className={cn(
            "relative flex h-6 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 data-[state=open]:bg-accent",
            raised && "z-[57]",
          )}
        >
          <MessageSquare className="size-3" aria-hidden />
          {t("draft.cliSessions")}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={menu.ref as React.Ref<HTMLDivElement>}
        style={menu.style}
        side="top"
        align="start"
        sideOffset={6}
        className={cn("z-[58] w-80 p-1.5", menu.moving && "opacity-0")}
      >
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">{t("draft.cliSessionsHint")}</p>
        {loading && <p className="px-2 py-1 text-xs text-muted-foreground">{t("draft.cliSessionsLoading")}</p>}
        {error && <p className="max-w-72 px-2 py-1 text-xs whitespace-pre-wrap text-error">{error}</p>}
        {!loading && !error && items.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">{t("draft.cliSessionsEmpty")}</p>}
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {items.map((s) => (
            <button
              key={s.acp_session_id}
              type="button"
              title={s.updated_at ?? undefined}
              disabled={busy}
              onClick={() => {
                toggle(false);
                void useStore.getState().adoptCliSession(draftId, s.acp_session_id, s.title ?? "");
              }}
              className="flex h-7 items-center rounded-md px-2 text-left text-sm hover:bg-accent disabled:opacity-40"
            >
              <span className="truncate">{s.title?.trim() || t("draft.cliSessionsUntitled")}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
