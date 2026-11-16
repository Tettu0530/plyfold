import { ChevronLeft, CircleAlert, CircleCheck, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { seconds } from "@/lib/format";
import type { AuthKind, CheckResult, ProfileDetail, ProfileForm, ProfileSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { AGENT_NAMES, ProviderLogo } from "./icons";
import { Keys } from "./Keys";
import { useLiquidClip, useLiquidRevealed } from "./liquid/stage";
import { Segmented } from "./Segmented";

const AUTH_LABEL: Record<AuthKind, string> = { api: "公式 API", login: "既存のログイン", custom: "カスタムプロバイダー" };
const AUTH_ORDER: AuthKind[] = ["api", "login", "custom"];
const AUTH_DETAIL: Record<AuthKind, string> = {
  api: "公式 API にキーで接続します。",
  login: "CLI にすでにあるログインを使います。",
  custom: "カスタムプロバイダーにキーで接続します。",
};

// plyfold-profile の edit.rs と同じ対応（保存前の表示用。保存後はエンジンの値を使う）
const KEY_VAR: Record<string, Partial<Record<AuthKind, string>>> = {
  claude: { api: "ANTHROPIC_API_KEY", custom: "ANTHROPIC_AUTH_TOKEN" },
  codex: { api: "OPENAI_API_KEY", custom: "PLYFOLD_PROVIDER_KEY" },
  gemini: { api: "GEMINI_API_KEY", custom: "GEMINI_API_KEY" },
};
const BASE_HINT: Record<string, string> = {
  claude: "起動時に ANTHROPIC_BASE_URL として渡します",
  codex: "専用ディレクトリの config.toml に、プロバイダーとして書きます",
  gemini: "起動時に GOOGLE_GEMINI_BASE_URL として渡します",
};

function summaryAuth(p: ProfileSummary): AuthKind {
  return p.custom_provider ? "custom" : p.keyed ? "api" : "login";
}

/** プロファイルの画面。サイドバーの「プロファイル」から飛び出して広がる */
export function ProfilesView() {
  const view = useStore((s) => s.profilesView);
  const profiles = useStore((s) => s.profiles);
  const sessions = useStore((s) => s.sessions);
  const close = useStore((s) => s.closeProfiles);
  const revealed = useLiquidRevealed("profiles");
  const surface = useRef<HTMLDivElement>(null);
  const moving = useLiquidClip("profiles", surface);
  const agents = useMemo(() => profiles.filter((p) => p.name === p.agent && (p.agent !== "mock" || import.meta.env.DEV)).map((p) => p.agent), [profiles]);
  const [agent, setAgent] = useState<string>("claude");
  // 選んでいるプロファイル。null は新規
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
  const rows = profiles.filter((p) => p.agent === agent).sort((a, b) => Number(b.name === b.agent) - Number(a.name === a.agent) || a.name.localeCompare(b.name));
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
      aria-label="プロファイル"
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
        <span className="font-medium">プロファイル</span>
      </div>

      <div className="flex min-h-0 grow">
        <nav aria-label="エージェント" className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2">
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
          <p className="px-2 pb-1 text-xs leading-relaxed text-muted-foreground">キーは macOS のキーチェーンに保存します。ログでは伏せ字になります。</p>
        </nav>

        <section aria-label={`${AGENT_NAMES[agent] ?? agent} のプロファイル`} className="flex w-[340px] shrink-0 flex-col border-r">
          <div className="flex h-12 shrink-0 items-center gap-2 px-4">
            <h1 className="text-base font-semibold">{AGENT_NAMES[agent] ?? agent}</h1>
            <span className="grow" />
            <button type="button" onClick={() => setSelected(null)} className="flex h-7 items-center gap-1.5 rounded-lg border border-input px-2 hover:bg-accent">
              <Plus className="size-3.5" aria-hidden />
              追加
            </button>
          </div>
          <div role="listbox" aria-label="プロファイル" className="flex min-h-0 grow flex-col gap-1 overflow-y-auto px-2 pb-2">
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
                  className={cn("flex flex-col gap-1 rounded-lg border px-3 py-2 text-left", on ? "border-foreground/40 bg-muted" : "border-transparent hover:bg-accent")}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{p.name === p.agent ? "default" : p.label}</span>
                    <span className="text-xs text-muted-foreground">{AUTH_LABEL[summaryAuth(p)]}</span>
                    <span className="grow" />
                    <span className="text-xs text-muted-foreground">セッション {sessionCount(p.name)}</span>
                  </span>
                  {c && (
                    <span className={cn("flex items-center gap-1.5 text-xs", c.ok ? "text-muted-foreground" : "text-error")}>
                      {c.ok ? <CircleCheck className="size-3 text-working" aria-hidden /> : <CircleAlert className="size-3" aria-hidden />}
                      <span className="truncate">{c.ok ? `応答 ${c.reported_model ?? c.configured_model ?? "モデル名なし"}` : "接続できません"}</span>
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
  return (
    <div className="flex max-w-[560px] flex-col gap-2 p-6">
      <h2 className="text-base font-semibold">default</h2>
      <p className="text-muted-foreground">
        {AGENT_NAMES[agent] ?? agent} にすでにあるログインと設定を、そのまま使います。キーや接続先を分けたいときは、プロファイルを追加してください。
      </p>
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
  /** null は新規 */
  name: string | null;
  sessions: number;
  check?: CheckResult;
  onCheck: (name: string, r: CheckResult) => void;
  onSaved: (name: string) => void;
  onDeleted: () => void;
}

function Editor({ agent, name, sessions, check, onCheck, onSaved, onDeleted }: EditorProps) {
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

  const keyHint = keyVar && (
    <>
      {keyVar} として渡します
      {detail?.key_account && detail.form.auth === form.auth && (
        <>
          （キーチェーン: <span className="font-mono">{detail.key_account}</span>
          {detail.shared_with.length > 0 && `、${detail.shared_with.join(", ")} と共有`}）
        </>
      )}
    </>
  );
  const mismatch =
    check?.ok && check.reported_model && check.configured_model && !check.reported_model.toLowerCase().includes(check.configured_model.toLowerCase());

  return (
    <div className="flex max-w-[600px] flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{name ?? "新しいプロファイル"}</h2>
        <p className="text-muted-foreground">{AUTH_DETAIL[form.auth]}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="名前" htmlFor="pf-name" hint="英数字と - _。キーチェーンとディレクトリの名前になります">
          <Input id="pf-name" value={form.name} onChange={(e) => set({ name: e.target.value })} className="h-8 font-mono text-xs" autoFocus={!name} />
        </Field>
        <Field label="表示名" htmlFor="pf-label" hint="空なら名前を使います">
          <Input id="pf-label" value={form.label ?? ""} onChange={(e) => set({ label: e.target.value || null })} className="h-8 text-sm" />
        </Field>
      </div>

      {supported.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium">認証</span>
          <Segmented<AuthKind>
            label="認証"
            className="self-start"
            value={form.auth}
            onChange={(auth) => set({ auth })}
            options={AUTH_ORDER.filter((a) => supported.includes(a)).map((a) => ({ value: a, label: <span className="px-2">{AUTH_LABEL[a]}</span> }))}
          />
        </div>
      )}

      {needsKey && (
        <div className="flex flex-col gap-4">
          {form.auth === "custom" && (
            <Field label="ベース URL" htmlFor="pf-base" hint={BASE_HINT[agent]}>
              <Input
                id="pf-base"
                value={form.base_url ?? ""}
                placeholder="https://"
                onChange={(e) => set({ base_url: e.target.value || null })}
                className="h-8 font-mono text-xs"
              />
            </Field>
          )}
          <Field label="キー" htmlFor="pf-key" hint={keyHint}>
            {key === null && detail?.key_set && detail.form.auth === form.auth ? (
              <div className="flex gap-2">
                <Input id="pf-key" readOnly value={`••••••••••••${detail.key_tail ?? ""}`} className="h-8 grow font-mono text-xs" />
                <button type="button" onClick={() => setKey("")} className="h-8 shrink-0 rounded-lg border border-input px-3 hover:bg-accent">
                  置換
                </button>
              </div>
            ) : (
              <Input
                id="pf-key"
                type="password"
                autoComplete="off"
                value={key ?? ""}
                placeholder={detail?.key_set ? "新しいキー" : "キーを貼り付け"}
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
            設定ディレクトリをこのプロファイル専用にする
          </label>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {codexCustom
              ? "カスタムプロバイダーの設定を書くため、Codex では専用にします"
              : form.isolate
                ? `${detail?.config_dir_env ?? "設定ディレクトリの環境変数"} を、このプロファイル専用のディレクトリにします。ログインや履歴はほかのプロファイルと分かれます`
                : "CLI の普段の設定ディレクトリを使います"}
          </span>
        </div>
        <Switch id="pf-iso" checked={codexCustom || form.isolate} disabled={codexCustom} onCheckedChange={(isolate) => set({ isolate })} />
      </div>

      {name && (
        <section aria-labelledby="pf-check" className="flex flex-col gap-3 rounded-[10px] border p-4">
          <div className="flex items-center gap-2">
            <h3 id="pf-check" className="font-medium">
              接続テスト
            </h3>
            <span className="text-xs text-muted-foreground">短い問い合わせを 1 回送ります</span>
            <span className="grow" />
            {check && <span className="text-xs text-muted-foreground">前回 {new Date(check.at * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>}
            <button
              type="button"
              disabled={busy !== null || dirty}
              title={dirty ? "先に保存してください" : undefined}
              onClick={() => void runCheck()}
              className="h-7 rounded-lg border border-input px-3 hover:bg-accent disabled:opacity-40"
            >
              {busy === "check" ? "問い合わせ中" : "テスト"}
            </button>
          </div>
          {check && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              {(check.ok
                ? [
                    ["応答したモデル", check.reported_model ?? "—（エージェントが教えてくれません）"],
                    ["設定のモデル", check.configured_model ?? "—"],
                    ["最初の文字まで", check.first_text_ms !== null ? seconds(check.first_text_ms) : "—"],
                    ["起動から全体", seconds(check.total_ms)],
                    ["応答", check.reply],
                  ]
                : [["エラー", check.error ?? "不明"]]
              ).map(([k, v]) => (
                <div key={k} className={cn("flex flex-col gap-0.5", (k === "応答" || k === "エラー") && "col-span-2")}>
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className={cn("font-mono break-all", k === "エラー" && "whitespace-pre-wrap text-error")}>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {mismatch && (
            <div role="alert" className="flex gap-2 rounded-lg bg-permission/10 p-3 text-xs">
              <TriangleAlert className="size-4 shrink-0 text-permission" aria-hidden />
              <div className="flex flex-col gap-1">
                <span className="font-medium">応答したモデルが、設定したモデルと違います</span>
                <span className="leading-relaxed text-muted-foreground">
                  中継の途中で別のモデルに置き換わっている可能性があります。このプロファイルのセッションでは、ペインの見出しに応答モデルを出し続けます。
                </span>
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
              削除する（セッション {sessions} 件は残ります）
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="h-8 rounded-lg px-3 text-error hover:bg-error/10">
              削除…
            </button>
          ))}
        <span className="grow" />
        <button
          type="button"
          disabled={busy !== null || !dirty || !form.name}
          onClick={() => void save()}
          className="h-8 rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {busy === "save" ? "保存中" : "保存"}
        </button>
      </div>
    </div>
  );
}
