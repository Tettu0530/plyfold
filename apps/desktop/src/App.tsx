import { Columns2, Grid2x2, PanelLeft, Square } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { useEffect } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { GooDefs } from "./components/liquid/liquid";
import { LiquidStage } from "./components/liquid/stage";
import { DiffView } from "./components/DiffView";
import { ProfilesView } from "./components/ProfilesView";
import { Notifications } from "./components/Notifications";
import { SettingsView } from "./components/SettingsView";
import { MotionLab } from "./components/MotionLab";
import { PaneGrid } from "./components/pane/PaneGrid";
import { SearchCard } from "./components/SearchCard";
import { Segmented } from "./components/Segmented";
import { Sidebar } from "./components/Sidebar";
import { smooth } from "./components/motion";
import { useT } from "./i18n";
import { inTauri } from "./lib/api";
import { repoName } from "./lib/format";
import { useStore, type PaneCount } from "./state/store";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const s = useStore.getState();
      if (e.key === "k") {
        e.preventDefault();
        s.setSearchOpen(!s.searchOpen);
      } else if (e.key === ",") {
        e.preventDefault();
        if (s.settingsView) s.closeSettings();
        else s.openSettings();
      } else if (e.key === "b") {
        e.preventDefault();
        s.toggleSidebar();
      } else if (e.key === "n") {
        e.preventDefault();
        s.newDraft();
      } else if (e.key === ".") {
        const id = s.panes[s.focusedPane];
        if (id) {
          e.preventDefault();
          void s.cancel(id);
        }
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        const i = Number(e.key) - 1;
        if (i < s.paneCount) {
          e.preventDefault();
          s.focusPane(i);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const t = useT();
  const init = useStore((s) => s.init);
  const paneCount = useStore((s) => s.paneCount);
  const setPaneCount = useStore((s) => s.setPaneCount);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const focusedRepo = useStore((s) => {
    const id = s.panes[s.focusedPane];
    return id ? s.sessions[id]?.record.repo_path ?? null : null;
  });
  useShortcuts();
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <div className="flex h-full flex-col">
          <header data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-[84px]">
            <button
              type="button"
              aria-label={sidebarOpen ? t("app.hideSidebar") : t("app.showSidebar")}
              title={sidebarOpen ? t("app.hideSidebar") : t("app.showSidebar")}
              aria-pressed={sidebarOpen}
              onClick={toggleSidebar}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PanelLeft className="size-4" aria-hidden />
            </button>
            <span data-tauri-drag-region className="font-medium">
              {focusedRepo ? repoName(focusedRepo) : "Plyfold"}
            </span>
            <span data-tauri-drag-region className="grow" />
            <Segmented<PaneCount>
              label={t("app.paneCount")}
              value={paneCount}
              onChange={setPaneCount}
              options={[
                { value: 1 as PaneCount, label: <Square className="size-3.5" aria-hidden />, aria: t("app.panes", { count: 1 }) },
                { value: 2 as PaneCount, label: <Columns2 className="size-3.5" aria-hidden />, aria: t("app.panes", { count: 2 }) },
                { value: 4 as PaneCount, label: <Grid2x2 className="size-3.5" aria-hidden />, aria: t("app.panes", { count: 4 }) },
              ]}
            />
            <Notifications />
          </header>

          <div className="flex min-h-0 grow">
            {/* Closing the sidebar animates the clipping width only; the sidebar keeps its own width so its text never reflows.
                While closed it is inert, so focus and screen readers skip it */}
            <motion.div
              initial={false}
              animate={{ width: sidebarOpen ? 240 : 0 }}
              transition={smooth}
              inert={!sidebarOpen}
              className="flex shrink-0 overflow-hidden"
            >
              <Sidebar />
            </motion.div>
            <PaneGrid count={paneCount} />
          </div>
          {!inTauri && (
            <p className="fixed right-3 bottom-3 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              {t("app.browserOnly")}
            </p>
          )}
        </div>
        <GooDefs />
        <DiffView />
        <ProfilesView />
        <SettingsView />
        <LiquidStage />
        <SearchCard />
        <MotionLab />
      </TooltipProvider>
    </MotionConfig>
  );
}
