import { ChevronLeft, FolderOpen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { useT, LANGS, type Lang } from "@/i18n";
import { api } from "@/lib/api";
import type { AppSettings, EditorChoice, SettingsView as Paths } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { Keys } from "./Keys";
import { useLiquidClip, useLiquidRevealed } from "./liquid/stage";
import { Segmented } from "./Segmented";

// auto の名前は描くときに引く（言語が途中で変わるため）
const EDITORS: { value: EditorChoice; label: string | null }[] = [
  { value: "auto", label: null },
  { value: "zed", label: "Zed" },
  { value: "cursor", label: "Cursor" },
  { value: "code", label: "VS Code" },
  { value: "finder", label: "Finder" },
];
const STALL = [60, 120, 300, 600];

/** 設定の画面。サイドバーの「設定」から飛び出して広がる。変えたらすぐ保存する */
export function SettingsView() {
  const t = useT();
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
      aria-label={t("settings.title")}
      aria-hidden={!visible}
      className={cn("fixed inset-x-0 top-10 bottom-0 flex flex-col bg-background transition-opacity duration-150", moving ? "pointer-events-none z-[56]" : "z-40", visible ? "opacity-100" : "pointer-events-none opacity-0")}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-3 pl-2">
        <button type="button" onClick={close} className="flex h-7 items-center gap-1 rounded-lg pr-2 pl-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronLeft className="size-4" aria-hidden />
          {t("settings.back")}
          <Keys keys={["esc"]} />
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{t("settings.title")}</span>
      </div>

      <div className="min-h-0 grow overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-8 px-6 py-8">
          <Section title={t("settings.sectionSession")}>
            <Row label={t("settings.workspace")} detail={settings.worktree_default ? t("settings.workspaceWorktree") : t("settings.workspaceInPlace")}>
              <Segmented<string>
                label={t("settings.workspace")}
                value={settings.worktree_default ? "wt" : "direct"}
                onChange={(v) => change({ worktree_default: v === "wt" })}
                options={[
                  { value: "wt", label: <span className="px-2">worktree</span> },
                  { value: "direct", label: <span className="px-2">{t("settings.inPlace")}</span> },
                ]}
              />
            </Row>
            <Row label={t("settings.language")} detail={settings.language === "auto" || !settings.language ? t("settings.languageAuto") : t("settings.languageFixed")}>
              <Segmented<"auto" | Lang>
                label={t("settings.language")}
                value={settings.language ?? "auto"}
                onChange={(v) => change({ language: v })}
                // 言語の名前は、その言語自身の表記で出す（どの画面でも同じ）
                options={[{ value: "auto" as const, label: <span className="px-2">{t("settings.auto")}</span> }, ...LANGS.map((l) => ({ value: l.value, label: <span className="px-2">{l.label}</span> }))]}
              />
            </Row>
            <Row label={t("settings.sendKey")} detail={settings.send_key === "cmd_enter" ? t("settings.sendCmdEnter") : t("settings.sendEnter")}>
              <Segmented<"enter" | "cmd_enter">
                label={t("settings.sendKey")}
                value={settings.send_key ?? "enter"}
                onChange={(v) => change({ send_key: v })}
                options={[
                  { value: "enter", aria: "Enter", label: <Keys keys={["enter"]} className="px-2" /> },
                  { value: "cmd_enter", aria: t("settings.cmdEnterAria"), label: <Keys keys={["cmd", "enter"]} className="px-2" /> },
                ]}
              />
            </Row>
            <Row label={t("settings.stall")} detail={t("settings.stallDetail")}>
              <Segmented<number>
                label={t("settings.stall")}
                value={settings.stall_seconds}
                onChange={(v) => change({ stall_seconds: v })}
                options={(STALL.includes(settings.stall_seconds) ? STALL : [...STALL, settings.stall_seconds].sort((a, b) => a - b)).map((v) => ({
                  value: v,
                  label: <span className="px-1.5 font-mono tabular">{v < 60 ? t("settings.seconds", { count: v }) : t("settings.minutes", { count: v / 60 })}</span>,
                }))}
              />
            </Row>
          </Section>

          <Section title={t("settings.sectionDiff")}>
            <Row label={t("settings.openInEditor")} detail={settings.editor === "auto" ? t("settings.editorAutoDetail") : t("settings.editorDetail")}>
              <Segmented<EditorChoice>
                label={t("settings.editor")}
                value={settings.editor}
                onChange={(editor) => change({ editor })}
                options={EDITORS.map((e) => ({ value: e.value, label: <span className="px-1.5">{e.label ?? t("settings.auto")}</span> }))}
              />
            </Row>
            <Row
              label={t("settings.cleanup")}
              htmlFor="st-cleanup"
              detail={
                settings.cleanup_after_merge
                  ? t("settings.cleanupOn")
                  : t("settings.cleanupOff")
              }
            >
              <Switch id="st-cleanup" checked={settings.cleanup_after_merge} onCheckedChange={(v) => change({ cleanup_after_merge: v })} />
            </Row>
          </Section>

          <Section title={t("settings.sectionStorage")}>
            <PathRow label={t("settings.profileConfig")} path={paths?.config_path} onReveal={() => void api.revealPath("config")} />
            <PathRow label={t("settings.stateDir")} path={paths?.state_dir} onReveal={() => void api.revealPath("data")} />
            <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.keychainNote")}</p>
          </Section>

          <Section title={t("settings.sectionMotion")}>
            <Row label={t("settings.motionLab")} detail={t("settings.motionLabDetail")}>
              <button type="button" onClick={() => setLabOpen(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
                <Sparkles className="size-3.5" aria-hidden />
                {t("settings.open")}
              </button>
            </Row>
          </Section>

          {error && <p className="text-xs whitespace-pre-wrap text-error">{t("settings.saveFailed", { error })}</p>}
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
  const t = useT();
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
        {t("settings.revealInFinder")}
      </button>
    </div>
  );
}
