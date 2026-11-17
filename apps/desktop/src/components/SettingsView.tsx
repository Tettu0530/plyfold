import { Bell, ChevronLeft, ExternalLink, FolderOpen, GitCompare, HardDrive, Info, Keyboard, MessagesSquare, SlidersHorizontal, Sparkles } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { useT, LANGS, type Lang, type MessageKey } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import type { AppInfo, AppSettings, EditorChoice, SettingsView as Paths } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { Keys } from "./Keys";
import { useLiquidClip, useLiquidRevealed } from "./liquid/stage";
import { Segmented } from "./Segmented";
import { ShortcutSettings } from "./ShortcutSettings";
import { ProviderLogo } from "./icons";
import { useLiquidMenu } from "./liquid/stage";
import { liquidAnchor } from "./liquid/liquid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SCALES } from "@/lib/scale";

// The label for auto is resolved at render time (the language can change)
const EDITORS: { value: EditorChoice; label: string | null }[] = [
  { value: "auto", label: null },
  { value: "zed", label: "Zed" },
  { value: "cursor", label: "Cursor" },
  { value: "code", label: "VS Code" },
  { value: "finder", label: "Finder" },
];
const STALL = [60, 120, 300, 600];

const SECTION_KEY = "plyfold.settingsSection";

const SECTIONS: { id: string; label: MessageKey; Icon: typeof Info }[] = [
  { id: "info", label: "settings.sectionInfo", Icon: Info },
  { id: "general", label: "settings.sectionGeneral", Icon: SlidersHorizontal },
  { id: "session", label: "settings.sectionSession", Icon: MessagesSquare },
  { id: "keyboard", label: "settings.sectionKeyboard", Icon: Keyboard },
  { id: "notifications", label: "settings.sectionNotifications", Icon: Bell },
  { id: "diff", label: "settings.sectionDiff", Icon: GitCompare },
  { id: "storage", label: "settings.sectionStorage", Icon: HardDrive },
  { id: "motion", label: "settings.sectionMotion", Icon: Sparkles },
];

/** Settings screen. Expands out of the sidebar's Settings item. Changes are saved immediately */
export function SettingsView() {
  const t = useT();
  const view = useStore((s) => s.settingsView);
  const close = useStore((s) => s.closeSettings);
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const setLabOpen = useStore((s) => s.setLabOpen);
  const revealed = useLiquidRevealed("settings");
  const surface = useRef<HTMLDivElement>(null);
  const moving = useLiquidClip("settings", surface, { cover: true });
  const [paths, setPaths] = useState<Paths | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One section at a time; the list on the left picks it (remembered for the next time settings open)
  const [current, setCurrent] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(SECTION_KEY);
      if (saved && SECTIONS.some((sec) => sec.id === saved)) return saved;
    } catch {
      // Not remembered: start from the top
    }
    return SECTIONS[0].id;
  });
  const pick = (id: string) => {
    setCurrent(id);
    try {
      localStorage.setItem(SECTION_KEY, id);
    } catch {
      // Only a convenience
    }
  };
  const tabs = useRef<HTMLDivElement>(null);
  // ↑↓ move through the list (like a tab list), focusing and showing the section
  const onTabKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = SECTIONS.findIndex((sec) => sec.id === current);
    const next = SECTIONS[(i + d + SECTIONS.length) % SECTIONS.length].id;
    pick(next);
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

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

      <div className="flex min-h-0 grow">
        {/* Section list: picks the one section shown on the right */}
        <div ref={tabs} role="tablist" aria-orientation="vertical" aria-label={t("settings.title")} onKeyDown={onTabKey} className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r px-2 py-4">
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              type="button"
              role="tab"
              id={`settings-tab-${sec.id}`}
              data-tab={sec.id}
              aria-selected={current === sec.id}
              aria-controls="settings-panel"
              tabIndex={current === sec.id ? 0 : -1}
              onClick={() => pick(sec.id)}
              className={cn("flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground", current === sec.id && "bg-accent text-foreground")}
            >
              <sec.Icon className="size-3.5 shrink-0" aria-hidden />
              {t(sec.label)}
            </button>
          ))}
        </div>
        <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${current}`} className="min-h-0 grow overflow-y-auto">
          <CurrentSection.Provider value={current}>
          <div className="mx-auto flex max-w-[640px] min-w-0 flex-col gap-10 px-6 py-8">
            <Section id="info" title={t("settings.sectionInfo")}>
              <InfoSection />
            </Section>

            <Section id="general" title={t("settings.sectionGeneral")}>
              <Row label={t("settings.language")} detail={settings.language === "auto" || !settings.language ? t("settings.languageAuto") : t("settings.languageFixed")}>
                <Segmented<"auto" | Lang>
                  label={t("settings.language")}
                  value={settings.language ?? "auto"}
                  onChange={(v) => change({ language: v })}
                  // Language names are shown in their own script (the same in every UI language)
                  options={[{ value: "auto" as const, label: <span className="px-2">{t("settings.auto")}</span> }, ...LANGS.map((l) => ({ value: l.value, label: <span className="px-2">{l.label}</span> }))]}
                />
              </Row>
              <Row label={t("settings.sidebarDensity")} detail={settings.sidebar_density === "compact" ? t("settings.sidebarCompactDetail") : t("settings.sidebarComfortableDetail")}>
                <Segmented<"comfortable" | "compact">
                  label={t("settings.sidebarDensity")}
                  value={settings.sidebar_density ?? "comfortable"}
                  onChange={(v) => change({ sidebar_density: v })}
                  options={[
                    { value: "comfortable", label: <span className="px-2">{t("settings.sidebarComfortable")}</span> },
                    { value: "compact", label: <span className="px-2">{t("settings.sidebarCompact")}</span> },
                  ]}
                />
              </Row>
                          <Row label={t("settings.uiScale")} detail={t("settings.uiScaleDetail")}>
                <Segmented<number>
                  label={t("settings.uiScale")}
                  value={settings.ui_scale ?? 100}
                  onChange={(v) => change({ ui_scale: v })}
                  options={(SCALES.includes(settings.ui_scale ?? 100) ? SCALES : [...SCALES, settings.ui_scale].sort((a, b) => a - b)).map((v) => ({ value: v, label: <span className="px-1 font-mono tabular">{v}%</span> }))}
                />
              </Row>
</Section>

            <Section id="session" title={t("settings.sectionSession")}>
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
                          <Row label={t("settings.defaultProfile")} detail={settings.default_profile ? t("settings.defaultProfileDetailFixed") : t("settings.defaultProfileDetailLast")}>
                <ProfilePicker value={settings.default_profile ?? ""} onChange={(v) => change({ default_profile: v })} />
              </Row>
              <Row label={t("settings.restorePanes")} htmlFor="st-restore" detail={settings.restore_panes === false ? t("settings.restorePanesOff") : t("settings.restorePanesOn")}>
                <Switch id="st-restore" checked={settings.restore_panes !== false} onCheckedChange={(v) => change({ restore_panes: v })} />
              </Row>
              <Row label={t("settings.thoughts")} detail={settings.thoughts_expanded ? t("settings.thoughtsDetailExpanded") : t("settings.thoughtsDetailCollapsed")}>
                <Segmented<string>
                  label={t("settings.thoughts")}
                  value={settings.thoughts_expanded ? "open" : "closed"}
                  onChange={(v) => change({ thoughts_expanded: v === "open" })}
                  options={[
                    { value: "closed", label: <span className="px-2">{t("settings.thoughtsCollapsed")}</span> },
                    { value: "open", label: <span className="px-2">{t("settings.thoughtsExpanded")}</span> },
                  ]}
                />
              </Row>
</Section>

            <Section id="keyboard" title={t("settings.sectionKeyboard")}>
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
              <div className="flex flex-col gap-1">
                <span className="font-medium">{t("settings.shortcuts")}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{t("settings.shortcutsDetail")}</span>
              </div>
              <ShortcutSettings onError={setError} />
            </Section>

            <Section id="notifications" title={t("settings.sectionNotifications")}>
              <Row label={t("settings.notifyTurnEnd")} htmlFor="st-notify-turn" detail={t("settings.notifyTurnEndDetail")}>
                <Switch id="st-notify-turn" checked={settings.notify_turn_end !== false} onCheckedChange={(v) => change({ notify_turn_end: v })} />
              </Row>
              <Row label={t("settings.notifyPermission")} htmlFor="st-notify-perm" detail={t("settings.notifyPermissionDetail")}>
                <Switch id="st-notify-perm" checked={settings.notify_permission !== false} onCheckedChange={(v) => change({ notify_permission: v })} />
              </Row>
            </Section>

            <Section id="diff" title={t("settings.sectionDiff")}>
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

            <Section id="storage" title={t("settings.sectionStorage")}>
              <PathRow label={t("settings.profileConfig")} path={paths?.config_path} onReveal={() => void api.revealPath("config")} />
              <PathRow label={t("settings.stateDir")} path={paths?.state_dir} onReveal={() => void api.revealPath("data")} />
              <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.keychainNote")}</p>
            </Section>

            <Section id="motion" title={t("settings.sectionMotion")}>
              <Row label={t("settings.reduceMotion")} detail={settings.reduce_motion === "reduce" ? t("settings.reduceMotionDetailOn") : t("settings.reduceMotionDetailSystem")}>
              <Segmented<"system" | "reduce">
                label={t("settings.reduceMotion")}
                value={settings.reduce_motion ?? "system"}
                onChange={(v) => change({ reduce_motion: v })}
                options={[
                  { value: "system", label: <span className="px-2">{t("settings.reduceSystem")}</span> },
                  { value: "reduce", label: <span className="px-2">{t("settings.reduceAlways")}</span> },
                ]}
              />
            </Row>
            <Row label={t("settings.motionLab")} detail={t("settings.motionLabDetail")}>
                <button type="button" onClick={() => setLabOpen(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
                  <Sparkles className="size-3.5" aria-hidden />
                  {t("settings.open")}
                </button>
              </Row>
            </Section>

            {error && <p className="text-xs whitespace-pre-wrap text-error">{t("settings.saveFailed", { error })}</p>}
          </div>
          </CurrentSection.Provider>
        </div>
      </div>
    </div>
  );
}

/** Which section is shown (only that one renders) */
const CurrentSection = createContext("info");

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  if (useContext(CurrentSection) !== id) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <h2 className="text-base font-medium">{title}</h2>
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

/** Profile for new sessions: "last used" or one profile (opens with the same liquid motion as other menus) */
function ProfilePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const profiles = useStore((s) => s.profiles);
  const menu = useLiquidMenu("menu:settings:profile", "settings:profile");
  const LAST = "__last__";
  return (
    <Select value={value || LAST} onValueChange={(v) => onChange(v === LAST ? "" : v)} onOpenChange={menu.onOpenChange}>
      <SelectTrigger ref={liquidAnchor("settings:profile")} aria-label={t("settings.defaultProfile")} className="h-8 min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent ref={menu.ref as React.Ref<HTMLDivElement>} style={menu.style} position="popper" align="end" sideOffset={6} className={cn("z-[58]", menu.moving && "opacity-0")}>
        <SelectItem value={LAST}>{t("settings.defaultProfileLast")}</SelectItem>
        {profiles.map((p) => (
          <SelectItem key={p.name} value={p.name}>
            <span className="flex items-center gap-1.5">
              <ProviderLogo agent={p.agent} className="size-3 text-muted-foreground" />
              {p.name === p.agent ? p.label : p.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI" };

/** Settings → Info: what this app is, its version and license, where the source is, and how the agents are started */
function InfoSection() {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (inTauri) void api.appInfo().then(setInfo).catch(() => setInfo(null));
  }, []);
  const repo = info?.repository ?? null;
  const facts: [string, React.ReactNode][] = [
    [t("settings.infoVersion"), info?.version ?? "—"],
    [t("settings.infoLicense"), info?.license ?? "—"],
    ["Tauri", info?.tauri ?? "—"],
    ["macOS", info?.os ? `${info.os} (${info.arch})` : "—"],
  ];
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="font-medium">Plyfold</span>
        <span className="text-xs leading-relaxed text-muted-foreground">{t("settings.infoTagline")}</span>
      </div>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="m-0 font-mono text-xs leading-5 select-text tabular">{v}</dd>
          </div>
        ))}
      </dl>
      {repo && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void api.openUrl(repo)} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
            <ExternalLink className="size-3.5" aria-hidden />
            {t("settings.infoSource")}
          </button>
          <button type="button" onClick={() => void api.openUrl(`${repo}/issues`)} className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent">
            <ExternalLink className="size-3.5" aria-hidden />
            {t("settings.infoIssues")}
          </button>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span className="font-medium">{t("settings.infoAgents")}</span>
        <span className="text-xs leading-relaxed text-muted-foreground">{t("settings.infoAgentsDetail")}</span>
        {(info?.agents ?? []).map((a) => (
          <div key={a.id} className="flex items-center gap-3">
            <span className="flex w-28 shrink-0 items-center gap-1.5">
              <ProviderLogo agent={a.id} className="size-3 text-muted-foreground" />
              {AGENT_NAMES[a.id] ?? a.id}
            </span>
            <code className="min-w-0 truncate font-mono text-xs text-muted-foreground select-text" title={a.command}>
              {a.command}
            </code>
          </div>
        ))}
        {!info && <span className="text-xs text-muted-foreground">—</span>}
      </div>
    </>
  );
}
