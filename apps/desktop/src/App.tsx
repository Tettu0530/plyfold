import { Columns2, Grid2x2, Square } from "lucide-react";
import { MotionConfig } from "motion/react";
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
  const init = useStore((s) => s.init);
  const paneCount = useStore((s) => s.paneCount);
  const setPaneCount = useStore((s) => s.setPaneCount);
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
            <span data-tauri-drag-region className="font-medium">
              {focusedRepo ? repoName(focusedRepo) : "Plyfold"}
            </span>
            <span data-tauri-drag-region className="grow" />
            <Segmented<PaneCount>
              label="ペインの数"
              value={paneCount}
              onChange={setPaneCount}
              options={[
                { value: 1 as PaneCount, label: <Square className="size-3.5" aria-hidden />, aria: "ペイン 1 枚" },
                { value: 2 as PaneCount, label: <Columns2 className="size-3.5" aria-hidden />, aria: "ペイン 2 枚" },
                { value: 4 as PaneCount, label: <Grid2x2 className="size-3.5" aria-hidden />, aria: "ペイン 4 枚" },
              ]}
            />
            <Notifications />
          </header>

          <div className="flex min-h-0 grow">
            <Sidebar />
            <PaneGrid count={paneCount} />
          </div>
          {!inTauri && (
            <p className="fixed right-3 bottom-3 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              ブラウザでは表示だけです（Tauri で起動するとエンジンにつながります）
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
