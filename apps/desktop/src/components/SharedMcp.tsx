// MCP servers set up once and passed to every profile (Settings → MCP). A profile's own server with the same name
// takes the shared one's place

import { useEffect, useState } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import type { McpServerForm } from "@/lib/types";
import { McpEditor } from "./ProfilesView";

export function SharedMcp() {
  const t = useT();
  const [servers, setServers] = useState<McpServerForm[] | null>(null);
  const [saved, setSaved] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.sharedMcp().then(
      (s) => {
        setServers(s);
        setSaved(JSON.stringify(s));
      },
      (e) => setError(String(e)),
    );
  }, []);

  if (!servers) return error ? <p className="text-xs whitespace-pre-wrap text-error">{error}</p> : null;
  const changed = JSON.stringify(servers) !== saved;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveSharedMcp(servers);
      setSaved(JSON.stringify(servers));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.sharedMcpHint")}</p>
      <McpEditor servers={servers} onChange={setServers} />
      {error && <p className="text-xs whitespace-pre-wrap text-error">{error}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!changed || busy}
          onClick={() => void save()}
          className="h-8 rounded-lg bg-primary px-3 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {t("settings.sharedMcpSave")}
        </button>
      </div>
    </div>
  );
}
