import { FolderOpen, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { AGENT_NAMES, ProviderLogo } from "./icons";
import { spring } from "./motion";

const LAST_REPO_KEY = "plyfold.lastRepo";

function readLastRepo(): string {
  try {
    return localStorage.getItem(LAST_REPO_KEY) ?? "~/projects";
  } catch {
    return "~/projects";
  }
}

export function NewSessionDialog() {
  const open = useStore((s) => s.newSessionOpen);
  const profiles = useStore((s) => s.profiles);
  const { setNewSessionOpen, startSession } = useStore.getState();
  const [profile, setProfile] = useState<string | null>(null);
  const [repo, setRepo] = useState(readLastRepo);
  const [worktree, setWorktree] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 名前のあるプロファイルを先に、エージェントそのもの（既定のプロファイル）を後に
  const sorted = useMemo(
    () => [...profiles].sort((a, b) => Number(a.name === a.agent) - Number(b.name === b.agent) || a.name.localeCompare(b.name)),
    [profiles],
  );
  useEffect(() => {
    if (open && !profile && sorted.length) setProfile(sorted[0].name);
  }, [open, profile, sorted]);

  const submit = async () => {
    if (!profile || busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.setItem(LAST_REPO_KEY, repo);
      } catch {
        // 保存できなくても続ける
      }
      const title = prompt.trim().split("\n")[0].slice(0, 40) || "新しいセッション";
      await startSession({ profile, repo, title, worktree, prompt });
      setPrompt("");
      setNewSessionOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setNewSessionOpen}>
      <DialogContent
        className="sm:max-w-[640px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>新しいセッション</DialogTitle>
          <DialogDescription>プロファイルとリポジトリを選ぶと、エージェントを起動して空いているペインに開きます。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ns-prompt">
            初期プロンプト <span className="font-normal text-muted-foreground">（任意）</span>
          </Label>
          <Textarea id="ns-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">プロファイル</legend>
          <div role="radiogroup" aria-label="プロファイル" className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto">
            {sorted.map((p) => {
              const on = p.name === profile;
              return (
                <button
                  key={p.name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setProfile(p.name)}
                  className={cn(
                    "flex items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-colors",
                    on ? "border-foreground" : "border-input hover:border-ring",
                  )}
                >
                  <span className={cn("mt-px flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-foreground" : "border-input")}>
                    {on && <motion.span layoutId="ns-radio" transition={spring} className="block size-2 rounded-full bg-foreground" />}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <ProviderLogo agent={p.agent} />
                      <span className="font-medium">{p.name === p.agent ? "default" : p.label}</span>
                      <span className="text-xs text-muted-foreground">{AGENT_NAMES[p.agent] ?? p.agent}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {p.custom_provider ? "カスタムプロバイダー" : p.keyed ? "API キー" : "既存のログイン"}
                      {p.custom_provider && <TriangleAlert className="size-3 text-permission" aria-label="応答モデルを確かめてください" />}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ns-repo">リポジトリ</Label>
            <div className="flex gap-2">
              <Input id="ns-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className="h-7 font-mono text-xs" />
              <Button type="button" variant="outline" size="icon" aria-label="フォルダを選ぶ" className="size-7">
                <FolderOpen className="size-4" />
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ns-worktree">作業場所</Label>
            <div className="flex h-7 items-center gap-2">
              <Switch id="ns-worktree" checked={worktree} onCheckedChange={setWorktree} />
              <span>{worktree ? "セッション専用の worktree" : "リポジトリで直接作業"}</span>
            </div>
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          {worktree ? "枝 plyfold/<セッション ID> を今の HEAD から切ります。元の作業ツリーは変わりません。" : "同じリポジトリを触るほかのセッションと、変更がぶつかる可能性があります。"}
        </p>
        {error && <p className="text-xs whitespace-pre-wrap text-error">{error}</p>}

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-7" onClick={() => setNewSessionOpen(false)}>
            キャンセル
          </Button>
          <Button size="sm" className="h-7 gap-2" disabled={!profile || busy} onClick={() => void submit()}>
            {busy ? "起動中…" : "始める"}
            <kbd className="font-mono text-xs opacity-60">⌘⏎</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
