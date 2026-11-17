import { ChevronLeft, CircleAlert, CircleCheck, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { type MessageKey, useT, currentLang } from "@/i18n";
import { api } from "@/lib/api";
import { seconds } from "@/lib/format";
import type { AuthKind, CheckResult, ProfileDetail, ProfileForm, ProfileSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { AGENT_NAMES, ProviderLogo } from "./icons";
import { Keys } from "./Keys";
import { useLiquidClip, useLiquidRevealed } from "./liquid/stage";
import { Segmented } from "./Segmented";

const AUTH_LABEL: Record<AuthKind, MessageKey> = { api: "profiles.authApi", login: "profiles.authLogin", custom: "profiles.authCustom" };
const AUTH_ORDER: AuthKind[] = ["api", "login", "custom"];
const AUTH_DETAIL: Record<AuthKind, MessageKey> = {
  api: "profiles.authApiDetail",
  login: "profiles.authLoginDetail",
  custom: "profiles.authCustomDetail",
};

// Same mapping as plyfold-profile's edit.rs (for display before saving; after saving the engine's value is used)
const KEY_VAR: Record<string, Partial<Record<AuthKind, string>>> = {
  claude: { api: "ANTHROPIC_API_KEY", custom: "ANTHROPIC_AUTH_TOKEN" },
  codex: { api: "OPENAI_API_KEY", custom: "PLYFOLD_PROVIDER_KEY" },
  gemini: { api: "GEMINI_API_KEY", custom: "GEMINI_API_KEY" },
};
const BASE_HINT: Record<string, MessageKey> = {
  claude: "profiles.baseHintClaude",
  codex: "profiles.baseHintCodex",
  gemini: "profiles.baseHintGemini",
};

function summaryAuth(p: ProfileSummary): AuthKind {
  return p.custom_provider ? "custom" : p.keyed ? "api" : "login";
}

/** Profiles screen. Expands out of the sidebar's Profiles item */
export function ProfilesView() {
  const t = useT();
  const view = useStore((s) => s.profilesView);
  const profiles = useStore((s) => s.profiles);
  const sessions = useStore((s) => s.sessions);
  const close = useStore((s) => s.closeProfiles);
  const revealed = useLiquidRevealed("profiles");
  const surface = useRef<HTMLDivElement>(null);
  const moving = useLiquidClip("profiles", surface, { cover: true });
  const agents = useMemo(() => profiles.filter((p) => p.name === p.agent && (p.agent !== "mock" || import.meta.env.DEV)).map((p) => p.agent), [profiles]);
  const [agent, setAgent] = useState<string>("claude");
  // Selected profile. null means a new one
  const [selected, setSelected] = useState<string | null>("claude");
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});

  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, close]);

  if (!view) return null;
  const visible = revealed && !view.closing;
  const rows = profiles
    .filter((p) => p.agent === agent)
    .sort((a, b) => Number(b.name === b.agent) - Number(a.name === a.agent) || a.name.localeCompare(b.name));
  const sessionCount = (name: string) => Object.values(sessions).filter((v) => v.record.profile === name).length;
  const pickAgent = (a: string) => {
    setAgent(a);
    setSelected(a);
  };

  return (
    <div
      ref={surface}
      data-profiles-view
      role="dialog"
      aria-label={t("profiles.title")}
      aria-hidden={!visible}
      className={cn(
        "fixed inset-x-0 top-10 bottom-0 flex flex-col bg-background transition-opacity duration-150",
        moving ? "pointer-events-none z-[56]" : "z-40",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-3 pl-2">
        <button
          type="button"
          onClick={close}
          className="flex h-7 items-center gap-1 rounded-lg pr-2 pl-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {t("profiles.back")}
          <Keys keys={["esc"]} />
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{t("profiles.title")}</span>
      </div>

      <div className="flex min-h-0 grow">
        <nav aria-label={t("profiles.agents")} className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2">
          {agents.map((a) => (
            <button
              key={a}
              type="button"
              aria-current={a === agent ? "page" : undefined}
              onClick={() => pickAgent(a)}
              className={cn("flex h-7 items-center gap-2 rounded-lg px-2 hover:bg-accent", a === agent ? "bg-muted font-medium" : "text-muted-foreground")}
            >
              <ProviderLogo agent={a} className="size-3.5" />
              <span className="grow text-left">{AGENT_NAMES[a] ?? a}</span>
              <span className="font-mono text-xs text-muted-foreground tabular">{profiles.filter((p) => p.agent === a).length}</span>
            </button>
          ))}
          <span className="grow" />
          <p className="px-2 pb-1 text-xs leading-relaxed text-muted-foreground">{t("profiles.keychainNote")}</p>
        </nav>

        <section aria-label={t("profiles.agentProfiles", { agent: AGENT_NAMES[agent] ?? agent })} className="flex w-[340px] shrink-0 flex-col border-r">
          <div className="flex h-12 shrink-0 items-center gap-2 px-4">
            <h1 className="text-base font-semibold">{AGENT_NAMES[agent] ?? agent}</h1>
            <span className="grow" />
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="flex h-7 items-center gap-1.5 rounded-lg border border-input px-2 hover:bg-accent"
            >
              <Plus className="size-3.5" aria-hidden />
              {t("profiles.add")}
            </button>
          </div>
          <div role="listbox" aria-label={t("profiles.title")} className="flex min-h-0 grow flex-col gap-1 overflow-y-auto px-2 pb-2">
            {rows.map((p) => {
              const c = checks[p.name];
              const on = p.name === selected;
              return (
                <button
                  key={p.name}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => setSelected(p.name)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border px-3 py-2 text-left",
                    on ? "border-foreground/40 bg-muted" : "border-transparent hover:bg-accent",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{p.name === p.agent ? "default" : p.label}</span>
                    <span className="text-xs text-muted-foreground">{t(AUTH_LABEL[summaryAuth(p)])}</span>
                    <span className="grow" />
                    <span className="text-xs text-muted-foreground">{t("profiles.sessionCount", { count: sessionCount(p.name) })}</span>
                  </span>
                  {c && (
                    <span className={cn("flex items-center gap-1.5 text-xs", c.ok ? "text-muted-foreground" : "text-error")}>
                      {c.ok ? <CircleCheck className="size-3 text-working" aria-hidden /> : <CircleAlert className="size-3" aria-hidden />}
                      <span className="truncate">
                        {c.ok
                          ? t("profiles.replied", { model: c.reported_model ?? c.configured_model ?? t("profiles.noModelName") })
                          : t("profiles.cannotConnect")}
                      </span>
                      {c.ok && c.first_text_ms !== null && <span className="ml-auto font-mono tabular">{seconds(c.first_text_ms)}</span>}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <main className="min-w-0 grow overflow-y-auto">
          {selected === agent ? (
            <DefaultProfile agent={agent} />
          ) : (
            <Editor
              key={selected ?? `new:${agent}`}
              agent={agent}
              name={selected}
              sessions={selected ? sessionCount(selected) : 0}
              check={selected ? checks[selected] : undefined}
              onCheck={(name, r) => setChecks((c) => ({ ...c, [name]: r }))}
              onSaved={(name) => setSelected(name)}
              onDeleted={() => setSelected(agent)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function DefaultProfile({ agent }: { agent: string }) {
  const t = useT();
  return (
    <div className="flex max-w-[560px] flex-col gap-2 p-6">
      <h2 className="text-base font-semibold">default</h2>
      <p className="text-muted-foreground">{t("profiles.defaultDetail", { agent: AGENT_NAMES[agent] ?? agent })}</p>
    </div>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="font-medium">
        {label}
      </label>
      {children}
      {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </div>
  );
}

interface EditorProps {
  agent: string;
  /** null means a new one */
  name: string | null;
  sessions: number;
  check?: CheckResult;
  onCheck: (name: string, r: CheckResult) => void;
  onSaved: (name: string) => void;
  onDeleted: () => void;
}

function Editor({ agent, name, sessions, check, onCheck, onSaved, onDeleted }: EditorProps) {
  const t = useT();
  const refreshProfiles = useStore((s) => s.refreshProfiles);
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [form, setForm] = useState<ProfileForm>({ name: "", agent, label: null, auth: KEY_VAR[agent] ? "api" : "login", base_url: null, isolate: true });
  const [key, setKey] = useState<string | null>(name ? null : "");
  const [busy, setBusy] = useState<"save" | "check" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = async (n: string) => {
    const d = await api.profileDetail(n);
    setDetail(d);
    setForm(d.form);
  };
  useEffect(() => {
    if (name) void load(name).catch((e) => setError(String(e)));
  }, [name]);

  if (name && !detail) return error ? <p className="p-6 text-xs text-error">{error}</p> : null;
  const supported = detail?.supported ?? (KEY_VAR[agent] ? AUTH_ORDER : ["login"]);
  const keyVar = detail && detail.form.auth === form.auth ? detail.key_var : (KEY_VAR[agent]?.[form.auth] ?? null);
  const needsKey = form.auth !== "login";
  const codexCustom = agent === "codex" && form.auth === "custom";
  const dirty = !detail || JSON.stringify(form) !== JSON.stringify(detail.form) || !!key;
  const set = (patch: Partial<ProfileForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      await api.saveProfile({ ...form, isolate: codexCustom || form.isolate }, name);
      if (needsKey && key) await api.setProfileKey(form.name, key);
      await refreshProfiles();
      setKey(null);
      onSaved(form.name);
      await load(form.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const runCheck = async () => {
    if (!name) return;
    setBusy("check");
    try {
      onCheck(name, await api.checkProfile(name));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!name) return;
    setBusy("delete");
    try {
      await api.deleteProfile(name);
      await refreshProfiles();
      onDeleted();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };

  // Split the translated text at {account} and insert the keychain name there so only it is monospaced
  const keyHint =
    keyVar &&
    (() => {
      if (!(detail?.key_account && detail.form.auth === form.auth)) return t("profiles.keyPassedAs", { var: keyVar });
      const mark = "\u0000";
      const [before, after] = (
        detail.shared_with.length > 0
          ? t("profiles.keyPassedAsKeychainShared", { var: keyVar, account: mark, shared: detail.shared_with.join(", ") })
          : t("profiles.keyPassedAsKeychain", { var: keyVar, account: mark })
      ).split(mark);
      return (
        <>
          {before}
          <span className="font-mono">{detail.key_account}</span>
          {after}
        </>
      );
    })();
  const mismatch =
    check?.ok && check.reported_model && check.configured_model && !check.reported_model.toLowerCase().includes(check.configured_model.toLowerCase());

  return (
    <div className="flex max-w-[600px] flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{name ?? t("profiles.newProfile")}</h2>
        <p className="text-muted-foreground">{t(AUTH_DETAIL[form.auth])}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label={t("profiles.name")} htmlFor="pf-name" hint={t("profiles.nameHint")}>
          <Input id="pf-name" value={form.name} onChange={(e) => set({ name: e.target.value })} className="h-8 font-mono text-xs" autoFocus={!name} />
        </Field>
        <Field label={t("profiles.displayName")} htmlFor="pf-label" hint={t("profiles.displayNameHint")}>
          <Input id="pf-label" value={form.label ?? ""} onChange={(e) => set({ label: e.target.value || null })} className="h-8 text-sm" />
        </Field>
      </div>

      {supported.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium">{t("profiles.auth")}</span>
          <Segmented<AuthKind>
            label={t("profiles.auth")}
            className="self-start"
            value={form.auth}
            onChange={(auth) => set({ auth })}
            options={AUTH_ORDER.filter((a) => supported.includes(a)).map((a) => ({ value: a, label: <span className="px-2">{t(AUTH_LABEL[a])}</span> }))}
          />
        </div>
      )}

      {needsKey && (
        <div className="flex flex-col gap-4">
          {form.auth === "custom" && (
            <Field label={t("profiles.baseUrl")} htmlFor="pf-base" hint={BASE_HINT[agent] && t(BASE_HINT[agent])}>
              <Input
                id="pf-base"
                value={form.base_url ?? ""}
                placeholder="https://"
                onChange={(e) => set({ base_url: e.target.value || null })}
                className="h-8 font-mono text-xs"
              />
            </Field>
          )}
          <Field label={t("profiles.key")} htmlFor="pf-key" hint={keyHint}>
            {key === null && detail?.key_set && detail.form.auth === form.auth ? (
              <div className="flex gap-2">
                <Input id="pf-key" readOnly value={`••••••••••••${detail.key_tail ?? ""}`} className="h-8 grow font-mono text-xs" />
                <button type="button" onClick={() => setKey("")} className="h-8 shrink-0 rounded-lg border border-input px-3 hover:bg-accent">
                  {t("profiles.replace")}
                </button>
              </div>
            ) : (
              <Input
                id="pf-key"
                type="password"
                autoComplete="off"
                value={key ?? ""}
                placeholder={detail?.key_set ? t("profiles.newKey") : t("profiles.pasteKey")}
                onChange={(e) => setKey(e.target.value)}
                className="h-8 font-mono text-xs"
              />
            )}
          </Field>
        </div>
      )}

      <div className="flex items-start gap-4">
        <div className="flex grow flex-col gap-1">
          <label htmlFor="pf-iso" className="font-medium">
            {t("profiles.isolate")}
          </label>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {codexCustom
              ? t("profiles.isolateCodexCustom")
              : form.isolate
                ? detail?.config_dir_env
                  ? t("profiles.isolateOnEnv", { env: detail.config_dir_env })
                  : t("profiles.isolateOnGeneric")
                : t("profiles.isolateOff")}
          </span>
        </div>
        <Switch id="pf-iso" checked={codexCustom || form.isolate} disabled={codexCustom} onCheckedChange={(isolate) => set({ isolate })} />
      </div>

      {name && (
        <section aria-labelledby="pf-check" className="flex flex-col gap-3 rounded-[10px] border p-4">
          <div className="flex items-center gap-2">
            <h3 id="pf-check" className="font-medium">
              {t("profiles.checkTitle")}
            </h3>
            <span className="text-xs text-muted-foreground">{t("profiles.checkDetail")}</span>
            <span className="grow" />
            {check && (
              <span className="text-xs text-muted-foreground">
                {t("profiles.checkLast", {
                  time: new Date(check.at * 1000).toLocaleTimeString(currentLang() === "ja" ? "ja-JP" : "en-US", { hour: "2-digit", minute: "2-digit" }),
                })}
              </span>
            )}
            <button
              type="button"
              disabled={busy !== null || dirty}
              title={dirty ? t("profiles.saveFirst") : undefined}
              onClick={() => void runCheck()}
              className="h-7 rounded-lg border border-input px-3 hover:bg-accent disabled:opacity-40"
            >
              {busy === "check" ? t("profiles.checking") : t("profiles.test")}
            </button>
          </div>
          {check && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              {(check.ok
                ? ([
                    ["profiles.checkReportedModel", check.reported_model ?? t("profiles.checkNotReported")],
                    ["profiles.checkConfiguredModel", check.configured_model ?? "—"],
                    ["profiles.checkFirstText", check.first_text_ms !== null ? seconds(check.first_text_ms) : "—"],
                    ["profiles.checkTotal", seconds(check.total_ms)],
                    ["profiles.checkReply", check.reply],
                  ] as [MessageKey, string][])
                : ([["profiles.checkError", check.error ?? t("profiles.unknown")]] as [MessageKey, string][])
              ).map(([k, v]) => (
                <div key={k} className={cn("flex flex-col gap-0.5", (k === "profiles.checkReply" || k === "profiles.checkError") && "col-span-2")}>
                  <dt className="text-muted-foreground">{t(k)}</dt>
                  <dd className={cn("font-mono break-all", k === "profiles.checkError" && "whitespace-pre-wrap text-error")}>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {mismatch && (
            <div role="alert" className="flex gap-2 rounded-lg bg-permission/10 p-3 text-xs">
              <TriangleAlert className="size-4 shrink-0 text-permission" aria-hidden />
              <div className="flex flex-col gap-1">
                <span className="font-medium">{t("profiles.mismatchTitle")}</span>
                <span className="leading-relaxed text-muted-foreground">{t("profiles.mismatchDetail")}</span>
              </div>
            </div>
          )}
        </section>
      )}

      {error && <p className="text-xs whitespace-pre-wrap text-error">{error}</p>}

      <div className="flex items-center gap-2">
        {name &&
          (confirmDelete ? (
            <button type="button" disabled={busy !== null} onClick={() => void remove()} className="h-8 rounded-lg px-3 text-error hover:bg-error/10">
              {t("profiles.deleteConfirm", { count: sessions })}
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="h-8 rounded-lg px-3 text-error hover:bg-error/10">
              {t("profiles.delete")}
            </button>
          ))}
        <span className="grow" />
        <button
          type="button"
          disabled={busy !== null || !dirty || !form.name}
          onClick={() => void save()}
          className="h-8 rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {busy === "save" ? t("profiles.saving") : t("profiles.save")}
        </button>
      </div>
    </div>
  );
}
