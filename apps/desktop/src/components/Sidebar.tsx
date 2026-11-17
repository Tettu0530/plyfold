import { ChevronRight, KeyRound, Plus, Search, Settings } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useRef, useState } from "react";

import { age, repoName } from "@/lib/format";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, useStore } from "@/state/store";
import { ProviderLogo, STATUS, StatusIcon } from "./icons";
import { Keys } from "./Keys";
import { SessionMenu } from "./SessionMenu";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMovingAnchors } from "./liquid/stage";
import { smooth, snappy } from "./motion";
import { isImeKey } from "@/lib/keys";

export function Sidebar() {
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const paneCount = useStore((s) => s.paneCount);
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
    const list = Object.values(sessions).sort((a, b) => b.record.updated_at - a.record.updated_at);
    for (const v of list) {
      const repo = repoName(v.record.repo_path);
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), v]);
    }
    return [...byRepo.entries()];
  }, [sessions]);

  const open = new Set(panes.slice(0, paneCount).filter(Boolean));

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
          <Keys keys={["cmd", "n"]} />
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
          <Keys keys={["cmd", "k"]} />
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
                <span className="grow text-left">{repo}</span>
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
                      whileTap={{ scale: 1.03 }}
                      aria-current={open.has(r.id) ? "true" : undefined}
                      title={compact ? t("sidebar.rowTitle", { title: r.title, profile: r.profile === r.agent ? "default" : r.profile, age: age(r.updated_at) }) : undefined}
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
                        {unread[r.id] && <span role="img" aria-label={t("sidebar.unread")} className={cn("size-1.5 shrink-0 rounded-full", unread[r.id].error ? "bg-error" : "bg-foreground")} />}
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
      </div>

      <div className="flex flex-col border-t p-2">
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
          <Keys keys={["cmd", ","]} />
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
        className={cn("h-full w-0.5 bg-foreground/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100", active && "opacity-100")}
      />
    </div>
  );
}
