// Saved messages. Expands out of the sidebar item, or out of the button in the input
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, CircleX, FolderOpen, Library, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { repoName } from "@/lib/format";
import { canInsert, fillPrompt, matchesQuery } from "@/lib/prompts";
import type { SavedPrompt } from "@/lib/types";
import { cn } from "@/lib/utils";
import { defaultProfile, useStore } from "@/state/store";
import { usePromptsScreen } from "@/state/promptsScreen";
import { Keys } from "./Keys";
import { useLiquidClip, useLiquidRevealed } from "./liquid/stage";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

const ANY = "__any__";

type Draft = { id: string; name: string; body: string; repo: string };

function blank(): Draft {
  return { id: crypto.randomUUID(), name: "", body: "", repo: "" };
}

/** The session in the focused pane, when that pane is a session (not a draft or another tool) */
function focusedSession() {
  const s = useStore.getState();
  const id = s.panes[s.focusedPane];
  const record = id ? s.sessions[id]?.record : undefined;
  return record ?? null;
}

export function PromptsView() {
  const t = useT();
  const view = usePromptsScreen((s) => s.view);
  const close = usePromptsScreen((s) => s.close);
  const revealed = useLiquidRevealed("prompts");
  const surface = useRef<HTMLDivElement>(null);
  const moving = useLiquidClip("prompts", surface, { cover: true });
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!view) return;
    setError(null);
    setDraft(null);
    setQuery("");
    setOpenId(null);
    setConfirmId(null);
    if (!inTauri) return;
    void api
      .listPrompts()
      .then(setPrompts)
      .catch((e) => setError(String(e)));
    void api
      .listRepos()
      .then((list) => setRepos(list.map((r) => r.path)))
      .catch(() => setRepos([]));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, close]);

  const shown = useMemo(() => prompts.filter((p) => matchesQuery(p, query)), [prompts, query]);
  if (!view) return null;
  const visible = revealed && !view.closing;
  const session = focusedSession();

  const run = async (work: () => Promise<SavedPrompt[] | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) setPrompts(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!draft) return;
    void run(async () => {
      const next = await api.savePrompt({ id: draft.id, name: draft.name, body: draft.body, repo: draft.repo || null });
      setDraft(null);
      return next;
    });
  };

  const insert = (prompt: SavedPrompt) => {
    if (!session || !canInsert(prompt, session.repo_path)) return;
    const text = fillPrompt(prompt.body, { repo: session.repo_path ?? "", branch: session.branch ?? "" });
    useStore.getState().insertIntoComposer(session.id, text);
    close();
  };

  const start = (prompt: SavedPrompt) => {
    const s = useStore.getState();
    const profile = defaultProfile(s.profiles, s.settings.default_profile);
    if (!profile) {
      setError(t("composer.promptsNeedProfile"));
      return;
    }
    const repo = prompt.repo ?? session?.repo_path ?? null;
    if (!repo) {
      setError(t("composer.promptsNeedRepo"));
      return;
    }
    const body = fillPrompt(prompt.body, { repo, branch: session?.repo_path === repo ? (session.branch ?? "") : "" });
    void run(async () => {
      await s.startSession({ profile, repo, title: prompt.name.slice(0, 40), worktree: s.settings.worktree_default, prompt: body });
      close();
    });
  };

  const pickRepo = async () => {
    if (!draft || !inTauri) return;
    const picked = await openDialog({ directory: true, multiple: false, title: t("composer.promptsBrowse") }).catch(() => null);
    if (typeof picked === "string" && picked) {
      setRepos((list) => (list.includes(picked) ? list : [...list, picked]));
      setDraft({ ...draft, repo: picked });
    }
  };

  const exportFile = () => {
    void run(async () => {
      const path = await saveDialog({ title: t("composer.promptsExport"), filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      await api.exportPrompts(path);
    });
  };

  const importFile = () => {
    void run(async () => {
      const picked = await openDialog({ title: t("composer.promptsImport"), filters: [{ name: "JSON", extensions: ["json"] }], multiple: false });
      if (typeof picked !== "string") return;
      return api.importPrompts(picked);
    });
  };

  const repoOptions = draft && draft.repo && !repos.includes(draft.repo) ? [...repos, draft.repo] : repos;

  return (
    <div
      ref={surface}
      data-prompts-view
      role="dialog"
      aria-label={t("composer.prompts")}
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
          {t("composer.promptsBack")}
          <Keys keys={["esc"]} />
        </button>
        <span className="text-muted-foreground">/</span>
        <Library className="size-4" aria-hidden />
        <span className="font-medium">{t("composer.prompts")}</span>
      </div>

      <div className="flex min-h-0 w-full max-w-3xl grow flex-col gap-3 px-4 py-4">
        {error && (
          <p className="flex items-start gap-2 text-sm text-error">
            <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        {draft ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("composer.promptsName")}
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus required maxLength={80} disabled={busy} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("composer.promptsBody")}
              <Textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                required
                maxLength={20000}
                disabled={busy}
                className="min-h-40 text-sm"
              />
            </label>
            <p className="text-xs text-muted-foreground">{t("composer.promptsPlaceholders")}</p>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 grow flex-col gap-1 text-xs text-muted-foreground">
                {t("composer.promptsRepo")}
                <Select value={draft.repo || ANY} disabled={busy} onValueChange={(v) => setDraft({ ...draft, repo: v === ANY ? "" : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("composer.promptsAnyRepo")}</SelectItem>
                    {repoOptions.map((path) => (
                      <SelectItem key={path} value={path}>
                        {repoName(path)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <button
                type="button"
                onClick={() => void pickRepo()}
                disabled={busy}
                className="flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <FolderOpen className="size-4" aria-hidden />
                {t("composer.promptsBrowse")}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={busy}
                className="flex h-7 items-center rounded-lg bg-primary px-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                {t("composer.promptsSave")}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="flex h-7 items-center rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t("composer.promptsCancel")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("composer.promptsSearch")}
                aria-label={t("composer.promptsSearch")}
              />
              {inTauri && (
                <>
                  <button
                    type="button"
                    onClick={importFile}
                    disabled={busy}
                    className="flex h-9 shrink-0 items-center rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    {t("composer.promptsImport")}
                  </button>
                  <button
                    type="button"
                    onClick={exportFile}
                    disabled={busy}
                    className="flex h-9 shrink-0 items-center rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    {t("composer.promptsExport")}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setDraft(blank())}
                className="flex h-9 shrink-0 items-center rounded-lg bg-primary px-2 text-sm text-primary-foreground hover:bg-primary/90"
              >
                {t("composer.promptsNew")}
              </button>
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{query.trim() ? t("composer.promptsNoMatch") : t("composer.promptsEmpty")}</p>
            ) : (
              <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
                {shown.map((p) => {
                  const open = openId === p.id;
                  const allowed = !!session && canInsert(p, session.repo_path);
                  return (
                    <li key={p.id} className="rounded-lg hover:bg-accent">
                      <button type="button" onClick={() => setOpenId(open ? null : p.id)} className="flex h-8 w-full items-center gap-2 px-2 text-left">
                        <span className="truncate text-sm">{p.name}</span>
                        {p.repo && <span className="truncate text-xs text-muted-foreground">{repoName(p.repo)}</span>}
                      </button>
                      {open && (
                        <div className="flex flex-col gap-2 px-2 pt-1 pb-2">
                          <p className="text-xs whitespace-pre-wrap text-muted-foreground">{p.body}</p>
                          {!allowed && session && p.repo && <p className="text-xs text-muted-foreground">{t("composer.promptsNotThisRepo")}</p>}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={!allowed || busy}
                              onClick={() => insert(p)}
                              className="flex h-7 items-center rounded-lg px-2 text-sm hover:bg-accent disabled:opacity-40"
                            >
                              {t("composer.promptsInsert")}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => start(p)}
                              className="flex h-7 items-center rounded-lg px-2 text-sm hover:bg-accent disabled:opacity-40"
                            >
                              {t("composer.promptsStart")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDraft({ id: p.id, name: p.name, body: p.body, repo: p.repo ?? "" })}
                              className="flex h-7 items-center rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              {t("composer.promptsEdit")}
                            </button>
                            {confirmId === p.id ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void run(async () => api.deletePrompt(p.id))}
                                className="flex h-7 items-center gap-1 rounded-lg px-2 text-sm text-error hover:bg-accent disabled:opacity-40"
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                                {t("composer.promptsDeleteConfirm")}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmId(p.id)}
                                className="flex h-7 items-center rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                              >
                                {t("composer.promptsDelete")}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
