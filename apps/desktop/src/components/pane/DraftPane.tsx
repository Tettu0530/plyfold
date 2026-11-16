import { ArrowUp, ChevronsUpDown, FolderOpen, GitBranch, Plus, X } from "lucide-react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { AGENT_NAMES, ProviderLogo } from "../icons";
import { CHIP_TRIGGER } from "./chip";

/** 認証の種類の表記 */
function authLabel(p: { keyed: boolean; custom_provider: boolean }) {
  return p.custom_provider ? "カスタムプロバイダー" : p.keyed ? "公式 API" : "既存のログイン";
}

/**
 * 新しいセッション（下書き）。既存のセッションと同じ画面で、会話は空。
 * 入力欄の上に、model / effort / mode の代わりにプロファイル・リポジトリ・worktree が並ぶ
 */
export function DraftPane({ index, id }: { index: number; id: string }) {
  const draft = useStore((s) => s.drafts[id]);
  const profiles = useStore((s) => s.profiles);
  const { updateDraft, startDraft, closePane, focusPane } = useStore.getState();
  const [text, setText] = useState("");
  if (!draft) return null;
  const sorted = [...profiles].sort((a, b) => Number(a.name === a.agent) - Number(b.name === b.agent) || a.name.localeCompare(b.name));
  const current = profiles.find((p) => p.name === draft.profile);
  const send = () => {
    if (draft.busy || !draft.profile) return;
    void startDraft(id, text);
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

      <div className="flex min-h-0 grow flex-col items-center justify-center gap-1 px-5 text-xs text-muted-foreground">
        {draft.busy ? <p>エージェントを起動しています</p> : <p>初期プロンプトを送ると始まります</p>}
        {draft.error && <p className="max-w-md text-center whitespace-pre-wrap text-error">{draft.error}</p>}
      </div>

      <Popover>
      <div className="flex shrink-0 flex-col px-3 pb-3">
      {/* リポジトリの欄は、この 1 行＋入力欄のまとまりと同じ幅で、すぐ上に開く */}
      <PopoverAnchor asChild>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-0.5 text-xs">
          <Select value={draft.profile ?? undefined} onValueChange={(v) => updateDraft(id, { profile: v })}>
            <SelectTrigger aria-label="プロファイル" className={`${CHIP_TRIGGER} gap-1.5`}>
              {current && <ProviderLogo agent={current.agent} className="size-3 text-muted-foreground" />}
              <span>{current ? (current.name === current.agent ? "default" : current.label) : "プロファイル"}</span>
              <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden />
            </SelectTrigger>
            <SelectContent>
              {sorted.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  <span className="flex items-center gap-2">
                    <ProviderLogo agent={p.agent} className="text-muted-foreground" />
                    <span>{p.name === p.agent ? "default" : p.label}</span>
                    <span className="text-xs text-muted-foreground">{AGENT_NAMES[p.agent] ?? p.agent}</span>
                    <span className="text-xs text-muted-foreground">{authLabel(p)}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <PopoverTrigger asChild>
            <button type="button" aria-label="リポジトリ" title={draft.repo} className="flex h-6 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent data-[state=open]:bg-accent">
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

        <div className="flex items-end gap-2 rounded-xl border border-input bg-card py-1.5 pr-1.5 pl-3 focus-within:border-ring">
          <textarea
            aria-label="初期プロンプト"
            rows={2}
            autoFocus
            value={text}
            placeholder="初期プロンプトを入力して始める"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
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
        </div>
      </div>
      </PopoverAnchor>
      </div>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-(--radix-popper-anchor-width) p-2">
        <Input
          aria-label="リポジトリのパス"
          value={draft.repo}
          onChange={(e) => updateDraft(id, { repo: e.target.value })}
          className="h-7 font-mono text-xs"
          autoFocus
        />
      </PopoverContent>
      </Popover>

    </section>
  );
}
