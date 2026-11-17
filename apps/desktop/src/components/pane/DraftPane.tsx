import { ArrowDown, ArrowUp, Check, Coins, FolderOpen, GitBranch, MessageSquare, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { money, repoName, tokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { AGENT_NAMES, ProviderLogo } from "../icons";
import { ControlRow } from "./Composer";
import { AttachBox, useAttachments } from "./Attachments";
import { useAutoGrow } from "./autoGrow";
import { RepoPicker } from "./RepoPicker";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";
import { withChoices } from "@/state/infoCache";
import type { Category, ProfileSummary, ProfileUsage } from "@/lib/types";
import { isSendKey } from "@/lib/keys";

/** 認証の種類の表記 */
function authLabel(p: { keyed: boolean; custom_provider: boolean }) {
  return p.custom_provider ? "カスタムプロバイダー" : p.keyed ? "公式 API" : "既存のログイン";
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

/** プロファイルの 1 行: 名前と認証の種類、直近 30 日のターン数・トークン・費用 */
function ProfileRow({ p, u, selected, onSelect }: { p: ProfileSummary; u: ProfileUsage | undefined; selected: boolean; onSelect: () => void }) {
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
          <span className="truncate">{authLabel(p)}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2.5 font-mono text-xs text-muted-foreground tabular">
        {u ? (
          <>
            <Num icon={MessageSquare} title={`ターン ${u.turns}（セッション ${u.sessions}）`}>
              {u.turns}
            </Num>
            {tok != null && (
              <span title={`入力 ${tokens(u.input ?? 0)}、出力 ${tokens(u.output ?? 0)}`} className="hidden items-center gap-[3px] @md:flex">
                <ArrowUp className="size-3" aria-hidden />
                {tokens(u.input ?? 0)}
                <ArrowDown className="ml-1 size-3" aria-hidden />
                {tokens(u.output ?? 0)}
              </span>
            )}
            {u.cost != null && (
              <Num icon={Coins} title="費用">
                {money(u.cost, u.currency ?? "USD")}
              </Num>
            )}
          </>
        ) : (
          <span title="直近 30 日は使っていません">—</span>
        )}
      </span>
      <Check className={cn("size-3.5 shrink-0", selected ? "text-foreground" : "invisible")} aria-hidden />
    </button>
  );
}

/**
 * 新しいセッション（下書き）。既存のセッションと同じ画面で、会話は空。
 * 真ん中にプロファイルの一覧（直近 30 日の使用状況つき）。入力欄の上は、左にリポジトリと worktree、右に model / effort / mode
 */
export function DraftPane({ index, id }: { index: number; id: string }) {
  const draft = useStore((s) => s.drafts[id]);
  const profiles = useStore((s) => s.profiles);
  const { updateDraft, startDraft, closePane, focusPane } = useStore.getState();
  const [text, setText] = useState("");
  const att = useAttachments();
  const sendKey = useStore((s) => s.settings.send_key ?? "enter");
  const textRef = useAutoGrow(text);
  const [repoOpen, setRepoOpen] = useState(false);
  // リポジトリの選択も、ボタンから飛び出して広がり、閉じるとボタンへ戻る（ほかのメニューと同じ分離アニメーション）
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
  // 最近使ったものを上に（使っていないものは、既定のプロファイルを先に名前順）
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
    <section aria-label={`ペイン ${index + 1}: 新しいセッション`} onMouseDown={() => focusPane(index)} className="flex min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <Plus className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">新しいセッション</span>
        <span className="grow" />
        <button
          type="button"
          aria-label="閉じる"
          onClick={() => closePane(index)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {/* 一覧はペインの真ん中に。入りきらなければ上下に流す（my-auto なら上が切れない） */}
      <div className="flex min-h-0 grow flex-col overflow-y-auto px-3 py-4">
      <div className="mx-auto my-auto w-full max-w-xl">
        <div className="mb-1 flex items-center justify-between px-2.5 text-xs text-muted-foreground">
          <span id={`${id}-profiles`}>プロファイル</span>
          <span>直近 30 日</span>
        </div>
        {/* 狭いときはトークンを隠す（行の幅で決める） */}
        <div role="radiogroup" aria-labelledby={`${id}-profiles`} onKeyDown={onListKey} className="@container flex flex-col gap-0.5">
          {ordered.map((p) => (
            <ProfileRow key={p.name} p={p} u={byProfile.get(p.name)} selected={p.name === draft.profile} onSelect={() => select(p.name)} />
          ))}
          {profiles.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">プロファイルがありません。サイドバーのプロファイルから足してください</p>}
        </div>
        {(draft.busy || draft.error) && (
          <div className="mt-3 px-2.5 text-xs">
            {draft.busy && <p className="text-muted-foreground">エージェントを起動しています</p>}
            {draft.error && <p className="whitespace-pre-wrap text-error">{draft.error}</p>}
          </div>
        )}
      </div>
      </div>

      <Popover open={repoOpen} onOpenChange={toggleRepo}>
      <div className="flex shrink-0 flex-col px-3 pb-3">
      {/* リポジトリの欄は、この 1 行＋入力欄のまとまりの左端にそろえて、すぐ上に開く */}
      <PopoverAnchor asChild>
      <div className="flex flex-col gap-1">
        {/* 幅が足りなければ、model / effort / mode は 2 段目に回る */}
        <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-xs">
          <div className="flex items-center gap-0.5">
          <PopoverTrigger asChild>
            <button
              ref={liquidAnchor(repoAnchor)}
              type="button"
              aria-label="リポジトリ"
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
            title={draft.worktree ? "セッション専用の worktree で作業します" : "リポジトリで直接作業します（ほかのセッションとぶつかる可能性があります）"}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md border px-1.5 hover:bg-accent",
              draft.worktree ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground",
            )}
          >
            <GitBranch className="size-3" aria-hidden />
            {draft.worktree ? "worktree" : "直接"}
          </button>
          </div>
          <span className="grow" />
          <ControlRow scope={id} agent={current?.agent ?? ""} info={info} onSet={choose} empty={draft.profile ? "model と effort は起動後に選べます" : undefined} />
        </div>

        <AttachBox att={att}>
          <textarea
            ref={textRef}
            aria-label="初期プロンプト"
            rows={1}
            autoFocus
            value={text}
            placeholder="初期プロンプトを入力して始める"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
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
            aria-label="始める"
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
        // 幅はペインいっぱいにしない（広いと実体が遠くまで飛んでから戻って見える）
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
