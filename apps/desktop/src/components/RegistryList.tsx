// Find, add, update or remove ACP Registry agents from the profiles screen.
import { ExternalLink, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import type { RegistryAgent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { agentName, ProviderLogo, Spinner } from "./icons";
import { openLink } from "./pane/Markdown";

function RegistryLogo({ agent }: { agent: RegistryAgent }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = agent.icon_url;
  const size = "mt-0.5 size-4 shrink-0";
  if (agent.built_in || !url || failedUrl === url) {
    return <ProviderLogo agent={agent.built_in ?? agent.id} className={cn(size, "text-muted-foreground")} />;
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(url)}
      className={cn(size, "object-contain brightness-0 invert-65")}
    />
  );
}

export function RegistryList({ onAdded }: { onAdded: (id: string) => void }) {
  const t = useT();
  const refreshProfiles = useStore((s) => s.refreshProfiles);
  const [list, setList] = useState<RegistryAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api.registryAgents().then(
      (l) => {
        setList(l);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  useEffect(() => {
    if (inTauri) void load();
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list ?? []).filter(
      (a) => !needle || a.name.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle) || a.id.includes(needle),
    );
  }, [list, q]);

  const run = async (id: string, f: () => Promise<void>, after?: () => void) => {
    setBusy(id);
    setError(null);
    try {
      await f();
      await refreshProfiles();
      await load();
      after?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label={t("profiles.registryTitle")} className="flex min-w-0 grow flex-col">
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">{t("profiles.registryTitle")}</h1>
          <span className="grow" />
          <div className="relative w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              aria-label={t("profiles.registrySearch")}
              placeholder={t("profiles.registrySearch")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 pl-7"
            />
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("profiles.registryHint")}</p>
      </div>
      {error && <p className="m-4 text-xs whitespace-pre-wrap text-error">{error}</p>}
      {!list && !error && (
        <p className="m-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" aria-hidden />
          {t("profiles.registryLoading")}
        </p>
      )}
      <ul className="m-0 flex min-h-0 grow list-none flex-col overflow-y-auto p-2">
        {shown.map((a) => {
          const update = a.added !== null && a.added !== a.version;
          return (
            <li key={a.id} className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-accent/40">
              <RegistryLogo agent={a} />
              <div className="flex min-w-0 grow flex-col gap-0.5">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium">{a.built_in ? agentName(a.built_in) : a.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">{a.version}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{a.kind}</span>
                  {a.license && <span className="shrink-0 text-xs text-muted-foreground">{a.license}</span>}
                </div>
                {a.description && <p className="m-0 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{a.description}</p>}
                {(a.repository ?? a.website) && (
                  <a
                    href={a.repository ?? a.website ?? undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      openLink(a.repository ?? a.website ?? undefined);
                    }}
                    className="flex w-fit items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3" aria-hidden />
                    {(a.repository ?? a.website ?? "").replace(/^https?:\/\//, "")}
                  </a>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {busy === a.id && <Spinner className="size-3.5 text-muted-foreground" aria-hidden />}
                {a.built_in ? (
                  <span className="text-xs text-muted-foreground">{t("profiles.registryBuiltIn")}</span>
                ) : !a.addable ? (
                  <span
                    className="text-xs text-muted-foreground"
                    title={a.unavailable === "platform" ? t("profiles.registryNoBuild") : t("profiles.registryNoChecksum")}
                  >
                    {t("profiles.registryBinary")}
                  </span>
                ) : a.added === null ? (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void run(
                        a.id,
                        () => api.addRegistryAgent(a.id),
                        () => onAdded(a.id),
                      )
                    }
                    className="h-7 rounded-lg border border-input px-2.5 text-xs hover:bg-accent disabled:opacity-40"
                  >
                    {t("profiles.registryAdd")}
                  </button>
                ) : (
                  <>
                    {update && (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void run(a.id, () => api.addRegistryAgent(a.id))}
                        className="h-7 rounded-lg border border-input px-2.5 text-xs hover:bg-accent disabled:opacity-40"
                      >
                        {t("profiles.registryUpdate", { version: a.version })}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void run(a.id, () => api.removeRegistryAgent(a.id))}
                      className={cn("h-7 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40")}
                    >
                      {t("profiles.registryRemove")}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
