// Settings → Repositories: per repository, what a new worktree gets (files copied in, a setup script) and which kinds
// of tool calls are allowed without asking
import { FolderGit2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT, type MessageKey } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import type { RepoEntry, RepoSettings as Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

const KINDS: { value: string; label: MessageKey }[] = [
  { value: "read", label: "settings.allowRead" },
  { value: "edit", label: "settings.allowEdit" },
  { value: "execute", label: "settings.allowExecute" },
  { value: "fetch", label: "settings.allowFetch" },
];

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function RepoSettings({ onError }: { onError: (e: string | null) => void }) {
  const t = useT();
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return setRepos([]);
    api.listRepos().then(
      (r) => {
        setRepos(r);
        setSel((s) => s ?? r[0]?.path ?? null);
      },
      (e) => onError(String(e)),
    );
  }, [onError]);
  if (!repos) return null;
  if (repos.length === 0) return <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.reposEmpty")}</p>;
  const current = repos.find((r) => r.path === sel) ?? repos[0];
  const save = (settings: Settings) => {
    setRepos((rs) => rs && rs.map((r) => (r.path === current.path ? { ...r, settings } : r)));
    api.saveRepoSettings(current.path, settings).then(
      () => onError(null),
      (e) => onError(String(e)),
    );
  };
  return (
    <div className="flex flex-col gap-5">
      <div role="listbox" aria-label={t("settings.sectionRepos")} className="flex flex-col gap-0.5">
        {repos.map((r) => (
          <button
            key={r.path}
            type="button"
            role="option"
            aria-selected={r.path === current.path}
            onClick={() => setSel(r.path)}
            className={cn("flex h-8 items-center gap-2 rounded-lg px-2 text-left hover:bg-accent", r.path === current.path && "bg-muted")}
          >
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 font-medium">{base(r.path)}</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={r.path}>
              {r.path}
            </span>
          </button>
        ))}
      </div>
      <RepoForm key={current.path} settings={current.settings} onSave={save} />
    </div>
  );
}

function RepoForm({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const t = useT();
  const [setup, setSetup] = useState(settings.setup);
  const [copy, setCopy] = useState(settings.copy.join("\n"));
  const lines = (v: string) =>
    v
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  return (
    <div className="flex flex-col gap-5 border-t pt-5">
      <Field id="repo-setup" label={t("settings.repoSetup")} detail={t("settings.repoSetupDetail")}>
        <Textarea
          id="repo-setup"
          value={setup}
          spellCheck={false}
          placeholder="npm install"
          onChange={(e) => setSetup(e.target.value)}
          onBlur={() => setup !== settings.setup && onSave({ ...settings, setup })}
          className="min-h-20 font-mono text-xs"
        />
      </Field>
      <Field id="repo-copy" label={t("settings.repoCopy")} detail={t("settings.repoCopyDetail")}>
        <Textarea
          id="repo-copy"
          value={copy}
          spellCheck={false}
          placeholder={".env\n.env.local"}
          onChange={(e) => setCopy(e.target.value)}
          onBlur={() => {
            const next = lines(copy);
            if (next.join("\n") !== settings.copy.join("\n")) onSave({ ...settings, copy: next });
          }}
          className="min-h-16 font-mono text-xs"
        />
      </Field>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t("settings.repoAllow")}</span>
          <span className="text-xs leading-relaxed text-muted-foreground">{t("settings.repoAllowDetail")}</span>
        </div>
        {KINDS.map((k) => (
          <label key={k.value} htmlFor={`repo-allow-${k.value}`} className="flex items-center justify-between gap-6">
            <span>{t(k.label)}</span>
            <Switch
              id={`repo-allow-${k.value}`}
              checked={settings.allow.includes(k.value)}
              onCheckedChange={(on) => onSave({ ...settings, allow: on ? [...settings.allow, k.value] : settings.allow.filter((a) => a !== k.value) })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function Field({ id, label, detail, children }: { id: string; label: string; detail: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        <span className="text-xs leading-relaxed text-muted-foreground">{detail}</span>
      </div>
      {children}
    </div>
  );
}
