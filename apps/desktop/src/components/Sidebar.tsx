import { ChevronRight, CircleArrowUp, KeyRound, ListTodo, Pencil, Play, Plus, RotateCcw, Search, Settings, Trash2, X } from "lucide-react";
import { Spinner } from "./icons";
import { motion, useReducedMotionConfig } from "motion/react";
import { useId, useMemo, useRef, useState } from "react";

import { age, repoName } from "@/lib/format";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, useStore, visibleSessions, isListed, isTrashed } from "@/state/store";
import { agentName, ProviderLogo, STATUS, StatusIcon, statusLabelKey } from "./icons";
import type { SessionRecord } from "@/lib/types";
import { Keys } from "./Keys";
import { SessionMenu } from "./SessionMenu";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu, useLiquidMovingAnchors } from "./liquid/stage";
import { smooth, snappy } from "./motion";
import { isImeKey } from "@/lib/keys";
import { startDrag } from "./pane/dnd";
import { keysOf } from "@/lib/keymap";
import { useBindings } from "@/state/keys";
import { installUpdate, useUpdate } from "@/state/update";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

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
  const repoNames = useStore((s) => s.repoNames);
  const chatGroupName = useStore((s) => s.settings.chat_group_name);
  const renameSession = useStore((s) => s.renameSession);

  // Grouped by repository, most recently updated first
  const groups = useMemo(() => {
    const byRepo = new Map<string, typeof list>();
    const list = Object.values(sessions)
      .filter(isListed)
      .sort((a, b) => b.record.updated_at - a.record.updated_at);
    // Everyday conversations are a group of their own, apart from the repositories
    for (const v of list) {
      // By the repository's path (two repositories with the same folder name are two groups); named below
      const repo = v.record.chat ? CHAT_GROUP : (v.record.repo_path ?? "");
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
        <TaskQueue />
        {groups.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">{t("sidebar.empty")}</p>}
        {groups.map(([repo, items]) => {
          const isClosed = !!closed[repo];
          const label = repo === CHAT_GROUP ? chatGroupName || t("sidebar.conversations") : repoNames[repo] || repoName(repo || null);
          return (
            <div key={repo}>
              <GroupHeader
                label={label}
                count={items.length}
                closed={isClosed}
                path={repo === CHAT_GROUP ? null : repo}
                onToggle={() => setClosed((c) => ({ ...c, [repo]: !c[repo] }))}
                onRename={(name) =>
                  repo === CHAT_GROUP ? useStore.getState().saveSettings({ chat_group_name: name.trim() }) : useStore.getState().renameRepoGroup(repo, name)
                }
              />
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
                            ? t("sidebar.rowTitle", { title: r.title, profile: r.profile === r.agent ? agentName(r.agent) : r.profile, age: age(r.updated_at) })
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
                            <StatusIcon status={r.status} chat={r.chat} className="size-3" />
                            {/* Compact rows keep the state icon (with its accessible label) but drop the word */}
                            {!compact && t(statusLabelKey(r.status, r.chat))}
                          </span>
                        </span>
                        {!compact && (
                          <span className="flex items-center gap-2 pl-[22px] text-xs text-muted-foreground">
                            <span className="min-w-0 grow truncate">{r.profile === r.agent ? agentName(r.agent) : r.profile}</span>
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
      </div>

      <div className="flex flex-col border-t p-2">
        <UpdateRow />
        {trashed.length > 0 && <TrashGroup items={trashed} />}
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
 * Sessions moved to the trash, in the sidebar footer (closed until opened). Each can be restored as it was or
 * deleted for good; deleting asks whether its worktree and branch go too. Records left for 30 days are deleted at the
 * next start, without their worktrees
 */
function TrashGroup({ items }: { items: SessionRecord[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { restoreSession, removeSession } = useStore.getState();
  const run = (p: Promise<void>) => {
    setError(null);
    void p.then(() => setConfirm(null)).catch((e) => setError(String(e)));
  };
  const anyWorktree = !!items.find((r) => r.id === confirm)?.worktree_path;
  const choices = confirm && (
    <div className="flex flex-col gap-0.5 rounded-lg border p-1">
      {anyWorktree && (
        <button
          type="button"
          onClick={() => run(removeSession(confirm, true))}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-error hover:bg-error/10"
        >
          <Trash2 className="size-3.5" aria-hidden />
          {t("sessionMenu.deleteWithWorktree")}
        </button>
      )}
      <button
        type="button"
        onClick={() => run(removeSession(confirm, false))}
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
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Trash2 className="size-4" aria-hidden />
        <span className="grow text-left">{t("sidebar.trash")}</span>
        <span className="font-mono text-xs tabular">{items.length}</span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={snappy} className="flex">
          <ChevronRight className="size-3.5" aria-hidden />
        </motion.span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 pb-2">
          <div className="max-h-[min(35dvh,20rem)] overflow-y-auto overscroll-contain">
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
          </div>
          <EmptyTrashButton count={items.length} hasWorktrees={items.some((r) => !!r.worktree_path)} />
          <p className="px-2 pt-0.5 text-xs leading-relaxed text-muted-foreground">{t("sidebar.trashNote")}</p>
          {error && <p className="px-2 text-xs whitespace-pre-wrap text-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

function EmptyTrashButton({ count, hasWorktrees }: { count: number; hasWorktrees: boolean }) {
  const t = useT();
  const description = useId();
  const reduced = useReducedMotionConfig();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const anchor = "sidebar-empty-trash";
  const menu = useLiquidMenu(`menu:${anchor}`, anchor, { hold: false });
  const raised = useLiquidActiveAnchors().has(anchor);
  const changeOpen = (next: boolean) => {
    if (!reduced) menu.onOpenChange(next);
    setOpen(next);
    if (next) setError(null);
  };
  const empty = async (removeWorktrees: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().emptyTrash(removeWorktrees);
      changeOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => !busy && changeOpen(next)}>
      <PopoverTrigger asChild>
        <motion.button
          ref={liquidAnchor(anchor)}
          type="button"
          whileTap={{ scale: 1.06 }}
          transition={snappy}
          className={cn(
            "relative flex h-7 items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-error data-[state=open]:bg-accent",
            raised && "z-[57]",
          )}
        >
          {t("sidebar.emptyTrash")}
        </motion.button>
      </PopoverTrigger>
      <PopoverContent
        ref={menu.ref as React.Ref<HTMLDivElement>}
        style={reduced ? undefined : menu.style}
        side="right"
        align="end"
        sideOffset={8}
        aria-label={t("sidebar.emptyTrash")}
        aria-describedby={description}
        aria-busy={busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        className={cn(
          "z-[58] flex w-64 flex-col gap-0.5 p-1.5 text-xs",
          menu.moving && "opacity-0",
          reduced &&
            "duration-150 data-[side=bottom]:slide-in-from-top-0 data-[side=left]:slide-in-from-right-0 data-[side=right]:slide-in-from-left-0 data-[side=top]:slide-in-from-bottom-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100",
        )}
      >
        <p id={description} className="px-2 py-1.5 text-muted-foreground">
          {t("sidebar.emptyTrashConfirm", { count })}
        </p>
        {(hasWorktrees ? [false, true] : [false]).map((removeWorktrees) => (
          <button
            key={String(removeWorktrees)}
            type="button"
            disabled={busy}
            onClick={() => void empty(removeWorktrees)}
            className="flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-left text-error hover:bg-error/10 disabled:opacity-50"
          >
            <Trash2 className="size-3.5 shrink-0" aria-hidden />
            {t(removeWorktrees ? "sidebar.emptyTrashWithWorktrees" : hasWorktrees ? "sidebar.emptyTrashKeepWorktrees" : "sidebar.emptyTrash")}
          </button>
        ))}
        {error && (
          <p role="alert" className="px-2 py-1 whitespace-pre-wrap text-error">
            {error}
          </p>
        )}
        <button
          ref={cancel}
          type="button"
          disabled={busy}
          onClick={() => changeOpen(false)}
          className="flex h-7 items-center rounded-md px-2 text-left hover:bg-accent disabled:opacity-50"
        >
          {t("sessionMenu.cancel")}
        </button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A group's header: opens and closes the group. Double-click it, or the pencil that shows on hover, to rename the
 * group in place (Enter keeps, Esc cancels, an empty name goes back to the default)
 */
function GroupHeader({
  label,
  count,
  closed,
  path,
  onToggle,
  onRename,
}: {
  label: string;
  count: number;
  closed: boolean;
  /** The repository's path (shown as the tooltip); null for conversations */
  path: string | null;
  onToggle: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = (name: string | null) => {
    setEditing(false);
    if (name === null || name.trim() === label) return;
    setError(null);
    void onRename(name).catch((e) => setError(String(e)));
  };
  if (editing) {
    return (
      <div className="mt-1 flex h-7 items-center pr-2 pl-1">
        <input
          aria-label={t("sidebar.groupName")}
          defaultValue={label}
          autoFocus
          maxLength={80}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !isImeKey(e)) done(e.currentTarget.value);
            else if (e.key === "Escape") done(null);
          }}
          onBlur={(e) => done(e.currentTarget.value)}
          className="h-6 min-w-0 grow rounded-sm bg-background px-1 text-xs outline outline-ring"
        />
      </div>
    );
  }
  return (
    <>
      <div className="group/head mt-1 flex h-7 items-center rounded-md text-xs text-muted-foreground hover:text-foreground">
        <button
          type="button"
          aria-expanded={!closed}
          title={path ?? undefined}
          onClick={onToggle}
          onDoubleClick={() => setEditing(true)}
          className="flex h-7 min-w-0 grow items-center gap-1 rounded-md pl-1"
        >
          <motion.span animate={{ rotate: closed ? 0 : 90 }} transition={snappy} className="flex shrink-0">
            <ChevronRight className="size-3.5" aria-hidden />
          </motion.span>
          <span className="min-w-0 grow truncate text-left">{label}</span>
        </button>
        <button
          type="button"
          aria-label={t("sidebar.renameGroup", { name: label })}
          title={t("sidebar.renameGroup", { name: label })}
          onClick={() => setEditing(true)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 group-hover/head:opacity-100 hover:bg-accent focus-visible:opacity-100"
        >
          <Pencil className="size-3" aria-hidden />
        </button>
        <span className="shrink-0 pr-2 pl-1 font-mono tabular">{count}</span>
      </div>
      {error && <p className="px-2 text-xs text-error">{error}</p>}
    </>
  );
}

/** Prompts waiting to start as sessions, first first (shown only while there are any) */
function TaskQueue() {
  const t = useT();
  const tasks = useStore((s) => s.tasks);
  const limit = useStore((s) => s.settings.max_parallel ?? 2);
  const profiles = useStore((s) => s.profiles);
  const [open, setOpen] = useState(true);
  if (tasks.length === 0) return null;
  const { cancelTask, startTaskNow } = useStore.getState();
  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={open}
        title={t("sidebar.queueHint", { count: limit })}
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex h-7 w-full items-center gap-1 rounded-md pr-2 pl-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={snappy} className="flex">
          <ChevronRight className="size-3.5" aria-hidden />
        </motion.span>
        <ListTodo className="size-3.5" aria-hidden />
        <span className="grow text-left">{t("sidebar.queue")}</span>
        <span className="font-mono tabular">{tasks.length}</span>
      </button>
      {open &&
        tasks.map((task) => {
          const agent = profiles.find((p) => p.name === task.profile)?.agent ?? task.profile;
          return (
            <div key={task.id} className="group flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-accent">
              <span className="flex min-w-0 items-center gap-2">
                <ProviderLogo agent={agent} className="text-muted-foreground" />
                <span className="min-w-0 grow truncate" title={task.prompt}>
                  {task.title}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-2 pl-[22px] text-xs text-muted-foreground">
                <span className="shrink-0">{task.profile === agent ? agentName(agent) : task.profile}</span>
                <span className="min-w-0 grow truncate">{repoName(task.repo)}</span>
                <button
                  type="button"
                  aria-label={t("sidebar.startNow", { title: task.title })}
                  title={t("sidebar.startNow", { title: task.title })}
                  onClick={() => void startTaskNow(task.id)}
                  className="flex size-5 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100"
                >
                  <Play className="size-3" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={t("sidebar.cancelTask", { title: task.title })}
                  title={t("sidebar.cancelTask", { title: task.title })}
                  onClick={() => void cancelTask(task.id)}
                  className="flex size-5 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-background hover:text-error focus-visible:opacity-100"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
              {task.error && <span className="pl-[22px] text-xs whitespace-pre-wrap text-error">{t("sidebar.taskFailed", { error: task.error })}</span>}
            </div>
          );
        })}
    </div>
  );
}
