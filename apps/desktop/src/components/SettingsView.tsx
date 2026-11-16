import { ChevronLeft, FolderOpen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type { AppSettings, EditorChoice, SettingsView as Paths } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { Keys } from "./Keys";
import { useLiquidClip, useLiquidRevealed } from "./liquid/stage";
import { Segmented } from "./Segmented";

const EDITORS: { value: EditorChoice; label: string }[] = [
  { value: "auto", label: "自動" },
  { value: "zed", label: "Zed" },
  { value: "cursor", label: "Cursor" },
  { value: "code", label: "VS Code" },
  { value: "finder", label: "Finder" },
];
const STALL = [60, 120, 300, 600];

/** 設定の画面。サイドバーの「設定」から飛び出して広がる。変えたらすぐ保存する */
export function SettingsView() {
  const view = useStore((s) => s.settingsView);
  const close = useStore((s) => s.closeSettings);
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const setLabOpen = useStore((s) => s.setLabOpen);
  const revealed = useLiquidRevealed("settings");
  const surface = useRef<HTMLDivElement>(null);
  const moving = useLiquidClip("settings", surface);
  const [paths, setPaths] = useState<Paths | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!view) return;
    setError(null);
    void api.getSettings().then(setPaths).catch(() => setPaths(null));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, close]);

  if (!view) return null;
  const visible = revealed && !view.closing;
  const change = (patch: Partial<AppSettings>) => {
    setError(null);
    save(patch).catch((e) => setError(String(e)));
  };

  return (
    <div
      ref={surface}
      data-settings-view
      role="dialog"
      aria-label="設定"
      aria-hidden={!visible}
      className={cn("fixed inset-x-0 top-10 bottom-0 flex flex-col bg-background transition-opacity duration-150", moving ? "pointer-events-none z-[56]" : "z-40", visible ? "opacity-100" : "pointer-events-none opacity-0")}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-3 pl-2">
        <button type="button" onClick={close} className="flex h-7 items-center gap-1 rounded-lg pr-2 pl-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronLeft className="size-4" aria-hidden />
          戻る
          <Keys keys={["esc"]} />
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">設定</span>
      </div>

      <div className="min-h-0 grow overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-8 px-6 py-8">
          <Section title="セッション">
            <Row label="新しいセッションの作業場所" detail={settings.worktree_default ? "セッション専用の worktree を切ります。元の作業ツリーは変わりません" : "リポジトリで直接作業します。ほかのセッションと変更がぶつかる可能性があります"}>
              <Segmented<string>
                label="新しいセッションの作業場所"
                value={settings.worktree_default ? "wt" : "direct"}
                onChange={(v) => change({ worktree_default: v === "wt" })}
                options={[
                  { value: "wt", label: <span className="px-2">worktree</span> },
                  { value: "direct", label: <span className="px-2">直接</span> },
                ]}
              />
            </Row>
            <Row label="無応答とみなすまで" detail="ターンの途中でこの時間なにも届かなければ、無応答として知らせます">
              <Segmented<number>
                label="無応答とみなすまで"
                value={settings.stall_seconds}
                onChange={(v) => change({ stall_seconds: v })}
                options={(STALL.includes(settings.stall_seconds) ? STALL : [...STALL, settings.stall_seconds].sort((a, b) => a - b)).map((v) => ({
                  value: v,
                  label: <span className="px-1.5 font-mono tabular">{v < 60 ? `${v}秒` : `${v / 60}分`}</span>,
                }))}
              />
            </Row>
          </Section>

          <Section title="差分">
            <Row label="エディタで開く" detail={settings.editor === "auto" ? "Zed、Cursor、VS Code の順に探し、なければ Finder で開きます" : "差分の画面の「エディタで開く」で使います"}>
              <Segmented<EditorChoice>
                label="エディタ"
                value={settings.editor}
                onChange={(editor) => change({ editor })}
                options={EDITORS.map((e) => ({ value: e.value, label: <span className="px-1.5">{e.label}</span> }))}
              />
            </Row>
            <Row
              label="取り込んだ後に worktree を片付ける"
              htmlFor="st-cleanup"
              detail={
                settings.cleanup_after_merge
                  ? "取り込みが済んだら、エージェントを止めて worktree と枝を消します。会話の記録は残り、開き直すと元のリポジトリで動きます"
                  : "取り込んだ後も worktree と枝を残します。セッションを消すときに一緒に消せます"
              }
            >
              <Switch id="st-cleanup" checked={settings.cleanup_after_merge} onCheckedChange={(v) => change({ cleanup_after_merge: v })} />
            </Row>
          </Section>

          <Section title="保存場所">
            <PathRow label="プロファイルの設定" path={paths?.config_path} onReveal={() => void api.revealPath("config")} />
            <PathRow label="セッションの記録と worktree" path={paths?.state_dir} onReveal={() => void api.revealPath("data")} />
            <p className="text-xs leading-relaxed text-muted-foreground">キーはここには保存せず、macOS のキーチェーン（サービス名 plyfold）に保存します。</p>
          </Section>

          <Section title="動き">
            <Row label="動きの見本" detail="ばねと分離の動きを試せます。macOS の「視差効果を減らす」をオンにすると、動きはフェードに変わります">
              <button type="button" onClick={() => setLabOpen(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
                <Sparkles className="size-3.5" aria-hidden />
                開く
              </button>
            </Row>
          </Section>

          {error && <p className="text-xs whitespace-pre-wrap text-error">保存できませんでした: {error}</p>}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

function Row({ label, detail, htmlFor, children }: { label: string; detail?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-6">
      <div className="flex min-w-0 grow flex-col gap-1">
        <label htmlFor={htmlFor} className="font-medium">
          {label}
        </label>
        {detail && <span className="text-xs leading-relaxed text-muted-foreground">{detail}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function PathRow({ label, path, onReveal }: { label: string; path?: string; onReveal: () => void }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex min-w-0 grow flex-col gap-1">
        <span className="font-medium">{label}</span>
        <span className="truncate font-mono text-xs text-muted-foreground select-text" title={path}>
          {path ?? "—"}
        </span>
      </div>
      <button type="button" onClick={onReveal} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
        <FolderOpen className="size-3.5" aria-hidden />
        Finder で開く
      </button>
    </div>
  );
}
