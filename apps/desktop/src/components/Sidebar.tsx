import { ChevronRight, CircleArrowUp, KeyRound, Plus, RotateCcw, Search, Settings, Trash2 } from "lucide-react";
import { Spinner } from "./icons";
import { motion } from "motion/react";
import { useMemo, useRef, useState } from "react";

import { age, repoName } from "@/lib/format";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, useStore, visibleSessions, isListed, isTrashed } from "@/state/store";
import { ProviderLogo, STATUS, StatusIcon } from "./icons";
import type { SessionRecord } from "@/lib/types";
import { Keys } from "./Keys";
import { SessionMenu } from "./SessionMenu";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMovingAnchors } from "./liquid/stage";
import { smooth, snappy } from "./motion";
import { isImeKey } from "@/lib/keys";
import { startDrag } from "./pane/dnd";
import { keysOf } from "@/lib/keymap";
import { useBindings } from "@/state/keys";
import { installUpdate, useUpdate } from "@/state/update";

/** Group key for everyday conversations (no repository name can contain a NUL) */
const CHAT_GROUP = "\0chat";

export function Sidebar() {
  const t = useT();
  const bindings = useBindings();
  const keys = { newSession: keysOf(bindings.newSession), search: keysOf(bindings.search), settings: keysOf(bindings.settings) };
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const layout = useStore((s) => s.layout);
  const openInPane = useStore((s) => s.openInPane);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const newDraft = useStore((s) => s.newDraft);
  const openSettings = useStore((s) => s.openSettings);
  const settingsOpen = useStore((s) => !!s.settingsView);
  const openProfiles = useStore((s) => s.openProfiles);
  const profilesOpen = useStore((s) => !!s.profilesView);
  // The blob emerges from behind its anchor (button or row) only. Blob sits above the sidebar background (55), the anchor above that (57)
  const searchLayer = useStore((s) => s.searchLayerActive);
  const unread = useStore((s) => s.unread);
  const active = useLiquidActiveAnchors();
  // The context menu lowers the row beneath the blob midway. Even then it keeps the selected color while animating
  const moving = useLiquidMovingAnchors();
  // Compact: one line per session; profile and age move to the row's tooltip
  const compact = useStore((s) => s.settings.sidebar_density === "compact");
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const searchOpen = useStore((s) => s.searchOpen);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  // Row being renamed
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameSession = useStore((s) => s.renameSession);

  // Grouped by repository, most recently updated first
  const groups = useMemo(() => {
    const byRepo = new Map<string, typeof list>();
    const list = Object.values(sessions)
      .filter(isListed)
      .sort((a, b) => b.record.updated_at - a.record.updated_at);
    // Everyday conversations are a group of their own, apart from the repositories
    for (const v of list) {
      const repo = v.record.chat ? CHAT_GROUP : repoName(v.record.repo_path);
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), v]);
    }
    return [...byRepo.entries()];
  }, [sessions]);

  const open = new Set(visibleSessions({ panes, layout }).filter(Boolean));
  const trashed = useMemo(
    () =>
      Object.values(sessions)
        .filter(isTrashed)
        .map((v) => v.record)
        .sort((a, b) => (b.trashed_at ?? 0) - (a.trashed_at ?? 0)),
    [sessions],
  );

  return (
    <nav aria-label={t("sidebar.label")} style={{ width: sidebarWidth }} className="relative flex shrink-0 flex-col border-r bg-sidebar">
      <SidebarResizer />
      <div className="flex flex-col p-2">
        <motion.button
          ref={liquidAnchor("new-session")}
          type="button"
          whileTap={{ scale: 1.06 }}
          transition={snappy}
          onClick={() => newDraft()}
          className={cn(
            "relative flex h-7 items-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
            active.has("new-session") && "z-[57] bg-accent text-foreground",
          )}
        >
          <Plus className="size-4" aria-hidden />
          <span className="grow text-left">{t("sidebar.newSession")}</span>
          <Keys keys={keys.newSession} />
        </motion.button>
        <motion.button
          ref={liquidAnchor("search")}
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          // Anchor: pops up when pressed and stays in the selected color (not dimmed) while open, to show where it came from
          animate={searchOpen ? { scale: [1, 1.06, 1] } : { scale: 1 }}
          transition={snappy}
          className={cn(
            "relative flex h-7 items-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
            searchLayer && "z-[57]",
            searchOpen && "bg-accent text-foreground",
          )}
        >
          <Search className="size-4" aria-hidden />
          <span className="grow text-left">{t("sidebar.search")}</span>
          <Keys keys={keys.search} />
        </motion.button>
      </div>

      <div className="flex min-h-0 grow flex-col overflow-y-auto px-2">
        {groups.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">{t("sidebar.empty")}</p>}
        {groups.map(([repo, items]) => {
          const isClosed = !!closed[repo];
          return (
            <div key={repo}>
              <button
                type="button"
                aria-expanded={!isClosed}
                onClick={() => setClosed((c) => ({ ...c, [repo]: !c[repo] }))}
                className="mt-1 flex h-7 w-full items-center gap-1 rounded-md pr-2 pl-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <motion.span animate={{ rotate: isClosed ? 0 : 90 }} transition={snappy} className="flex">
                  <ChevronRight className="size-3.5" aria-hidden />
                </motion.span>
                <span className="grow text-left">{repo === CHAT_GROUP ? t("sidebar.conversations") : repo}</span>
                <span className="font-mono tabular">{items.length}</span>
              </button>
              {!isClosed &&
                items.map(({ record: r }) => {
                  const st = STATUS[r.status];
                  const quiet = r.status === "idle" || r.status === "closed" || r.status === "starting";
                  return (
                    <SessionMenu key={r.id} record={r} onRename={() => setRenaming(r.id)}>
                      <motion.a
                        layout="position"
                        transition={smooth}
                        ref={liquidAnchor(`session:${r.id}`)}
                        href="#"
                        // Drag a row onto a pane to open it there, or onto a pane's edge to open it in a new split
                        draggable={false}
                        onPointerDown={(e) => {
                          if (renaming !== r.id) startDrag(e, () => ({ kind: "session", id: r.id, title: r.title, agent: r.agent }));
                        }}
                        whileTap={{ scale: 1.03 }}
                        aria-current={open.has(r.id) ? "true" : undefined}
                        title={
                          compact
                            ? t("sidebar.rowTitle", { title: r.title, profile: r.profile === r.agent ? "default" : r.profile, age: age(r.updated_at) })
                            : undefined
                        }
                        onClick={(e) => {
                          e.preventDefault();
                          void openInPane(r.id, undefined, `session:${r.id}`);
                        }}
                        className={cn(
                          "relative flex flex-col gap-1 rounded-lg text-foreground no-underline hover:bg-accent data-[state=open]:bg-accent",
                          compact ? "mb-0.5 px-2 py-1.5" : "mb-1 p-2",
                          (open.has(r.id) || moving.has(`session:${r.id}`)) && "bg-accent",
                          active.has(`session:${r.id}`) && "z-[57]",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ProviderLogo agent={r.agent} className="text-muted-foreground" />
                          {renaming === r.id ? (
                            <input
                              aria-label={t("sidebar.renameLabel")}
                              defaultValue={r.title}
                              autoFocus
                              onFocus={(e) => e.currentTarget.select()}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter" && !isImeKey(e)) {
                                  const v = e.currentTarget.value;
                                  setRenaming(null);
                                  void renameSession(r.id, v);
                                } else if (e.key === "Escape") setRenaming(null);
                              }}
                              onBlur={(e) => {
                                const v = e.currentTarget.value;
                                setRenaming(null);
                                if (v.trim() && v !== r.title) void renameSession(r.id, v);
                              }}
                              className="min-w-0 grow rounded-sm bg-background px-1 outline outline-ring"
                            />
                          ) : (
                            <span className="min-w-0 grow truncate">{r.title}</span>
                          )}
                          {unread[r.id] && (
                            <span
                              role="img"
                              aria-label={t("sidebar.unread")}
                              className={cn("size-1.5 shrink-0 rounded-full", unread[r.id].error ? "bg-error" : "bg-foreground")}
                            />
                          )}
                          <span className={cn("flex shrink-0 items-center gap-1 text-xs", quiet ? "text-muted-foreground" : st.color)}>
                            <StatusIcon status={r.status} className="size-3" />
                            {/* Compact rows keep the state icon (with its accessible label) but drop the word */}
                            {!compact && st.label}
                          </span>
                        </span>
                        {!compact && (
                          <span className="flex items-center gap-2 pl-[22px] text-xs text-muted-foreground">
                            <span className="min-w-0 grow truncate">{r.profile === r.agent ? "default" : r.profile}</span>
                            <span className="font-mono tabular">{age(r.updated_at)}</span>
                          </span>
                        )}
                      </motion.a>
                    </SessionMenu>
                  );
                })}
            </div>
          );
        })}
        {trashed.length > 0 && <TrashGroup items={trashed} />}
      </div>

      <div className="flex flex-col border-t p-2">
        <UpdateRow />
        <motion.button
          ref={liquidAnchor("profiles")}
          type="button"
          whileTap={{ scale: 1.06 }}
          transition={snappy}
          onClick={() => openProfiles()}
          className={cn(
            "relative flex h-7 items-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
            profilesOpen && "bg-accent text-foreground",
            active.has("profiles") && "z-[57] bg-accent text-foreground",
          )}
        >
          <KeyRound className="size-4" aria-hidden />
          <span className="grow text-left">{t("sidebar.profiles")}</span>
        </motion.button>
        <motion.button
          ref={liquidAnchor("settings")}
          type="button"
          whileTap={{ scale: 1.06 }}
          transition={snappy}
          onClick={() => openSettings()}
          className={cn(
            "relative flex h-7 items-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
            settingsOpen && "bg-accent text-foreground",
            active.has("settings") && "z-[57] bg-accent text-foreground",
          )}
        >
          <Settings className="size-4" aria-hidden />
          <span className="grow text-left">{t("sidebar.settings")}</span>
          <Keys keys={keys.settings} />
        </motion.button>
      </div>
    </nav>
  );
}

/**
 * The sidebar's right edge. Drag to resize (it follows the pointer), double-click or Enter for the default width,
 * arrow keys to nudge. Releasing well past the minimum width hides the sidebar (like Finder); it reopens at its last width
 */
function SidebarResizer() {
  const t = useT();
  const width = useStore((s) => s.sidebarWidth);
  const dragging = useRef<{ left: number; from: number; collapse: boolean } | null>(null);
  const [active, setActive] = useState(false);
  const end = () => {
    const d = dragging.current;
    dragging.current = null;
    document.body.classList.remove("resizing");
    setActive(false);
    useStore.setState({ sidebarResizing: false });
    if (d?.collapse) {
      // Hide it, and reopen later at the width it had before this drag
      useStore.getState().setSidebarWidth(d.from);
      useStore.getState().toggleSidebar();
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sidebar.resize")}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      title={t("sidebar.resizeHint")}
      tabIndex={0}
      onPointerDown={(e) => {
        // Don't start a text selection (it would select the panes' text while dragging)
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic events have no capturable pointer
        }
        const nav = e.currentTarget.parentElement?.getBoundingClientRect();
        dragging.current = { left: nav?.left ?? 0, from: useStore.getState().sidebarWidth, collapse: false };
        document.body.classList.add("resizing");
        setActive(true);
        useStore.setState({ sidebarResizing: true });
      }}
      onPointerMove={(e) => {
        const d = dragging.current;
        if (!d) return;
        const w = e.clientX - d.left;
        d.collapse = w < SIDEBAR_MIN - 80;
        useStore.getState().setSidebarWidth(w);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => useStore.getState().setSidebarWidth(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 8;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          useStore.getState().setSidebarWidth(width + (e.key === "ArrowLeft" ? -step : step));
        } else if (e.key === "Enter") useStore.getState().setSidebarWidth(SIDEBAR_DEFAULT);
      }}
      className="group absolute top-0 right-0 bottom-0 z-10 flex w-1.5 cursor-col-resize justify-end outline-none"
    >
      <span
        aria-hidden
        className={cn(
          "h-full w-0.5 bg-foreground/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
          active && "opacity-100",
        )}
      />
    </div>
  );
}

/** A newer version: one click downloads it, installs it and restarts (shown only when there is one) */
function UpdateRow() {
  const t = useT();
  const state = useUpdate((s) => s.state);
  if (state.kind !== "available" && state.kind !== "downloading") return null;
  const percent = state.kind === "downloading" && state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : null;
  return (
    <button
      type="button"
      disabled={state.kind === "downloading"}
      onClick={() => void installUpdate()}
      className="flex h-7 items-center gap-2 rounded-lg px-2 text-foreground hover:bg-accent disabled:hover:bg-transparent"
    >
      {state.kind === "downloading" ? <Spinner className="size-4" /> : <CircleArrowUp className="size-4" aria-hidden />}
      <span className="grow truncate text-left">
        {state.kind === "downloading" ? t("sidebar.updating", { version: state.version }) : t("sidebar.updateAvailable", { version: state.version })}
      </span>
      {percent !== null && <span className="font-mono text-xs text-muted-foreground tabular">{percent}%</span>}
    </button>
  );
}

/**
 * Sessions moved to the trash, at the end of the list (closed until opened). Each can be restored as it was or
 * deleted for good; deleting asks whether its worktree and branch go too. Records left for 30 days are deleted at the
 * next start, without their worktrees
 */
function TrashGroup({ items }: { items: SessionRecord[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // What is being deleted for good: one session, or everything ("all")
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { restoreSession, removeSession, emptyTrash } = useStore.getState();
  const run = (p: Promise<void>) => {
    setError(null);
    void p.then(() => setConfirm(null)).catch((e) => setError(String(e)));
  };
  const anyWorktree = confirm === "all" ? items.some((r) => r.worktree_path) : !!items.find((r) => r.id === confirm)?.worktree_path;
  const choices = confirm && (
    <div className="flex flex-col gap-0.5 rounded-lg border p-1">
      {anyWorktree && (
        <button
          type="button"
          onClick={() => run(confirm === "all" ? emptyTrash(true) : removeSession(confirm, true))}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-error hover:bg-error/10"
        >
          <Trash2 className="size-3.5" aria-hidden />
          {t("sessionMenu.deleteWithWorktree")}
        </button>
      )}
      <button
        type="button"
        onClick={() => run(confirm === "all" ? emptyTrash(false) : removeSession(confirm, false))}
        className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-error hover:bg-error/10"
      >
        <Trash2 className="size-3.5" aria-hidden />
        {anyWorktree ? t("sessionMenu.deleteRecordOnly") : t("sessionMenu.deleteRecord")}
      </button>
      <button type="button" onClick={() => setConfirm(null)} className="flex h-7 items-center rounded-md px-2 text-left text-xs hover:bg-accent">
        {t("sessionMenu.cancel")}
      </button>
    </div>
  );
  return (
    <div className="mt-2 mb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-full items-center gap-1 rounded-md pr-2 pl-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={snappy} className="flex">
          <ChevronRight className="size-3.5" aria-hidden />
        </motion.span>
        <Trash2 className="size-3.5" aria-hidden />
        <span className="grow text-left">{t("sidebar.trash")}</span>
        <span className="font-mono tabular">{items.length}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {items.map((r) => (
            <div key={r.id} className="flex flex-col gap-1">
              <div className="group flex h-8 items-center gap-2 rounded-lg pr-1 pl-2 hover:bg-accent">
                <ProviderLogo agent={r.agent} className="text-muted-foreground" />
                <span className="min-w-0 grow truncate text-muted-foreground" title={r.title}>
                  {r.title}
                </span>
                <button
                  type="button"
                  aria-label={t("sidebar.restore", { title: r.title })}
                  title={t("sidebar.restore", { title: r.title })}
                  onClick={() => run(restoreSession(r.id))}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={t("sidebar.deleteForGood", { title: r.title })}
                  title={t("sidebar.deleteForGood", { title: r.title })}
                  onClick={() => setConfirm(r.id)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-error focus-visible:opacity-100"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </div>
              {confirm === r.id && choices}
            </div>
          ))}
          {confirm === "all" ? (
            choices
          ) : (
            <button
              type="button"
              onClick={() => setConfirm("all")}
              className="flex h-7 items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-error"
            >
              {t("sidebar.emptyTrash")}
            </button>
          )}
          <p className="px-2 pt-0.5 text-xs leading-relaxed text-muted-foreground">{t("sidebar.trashNote")}</p>
          {error && <p className="px-2 text-xs whitespace-pre-wrap text-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
