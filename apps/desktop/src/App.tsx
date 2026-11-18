import { PanelLeft } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { Suspense, lazy, useEffect } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { GooDefs } from "./components/liquid/liquid";
import { LiquidStage } from "./components/liquid/stage";
import { ImagePreview } from "./components/ImagePreview";
import { ProfilesView } from "./components/ProfilesView";
import { Notifications } from "./components/Notifications";
import { SettingsView } from "./components/SettingsView";
import { PaneGrid } from "./components/pane/PaneGrid";
import { SearchCard } from "./components/SearchCard";
import { Sidebar } from "./components/Sidebar";
import { smooth } from "./components/motion";
import { useT } from "./i18n";
import { inTauri } from "./lib/api";
import { repoName } from "./lib/format";
import { leaves } from "./state/layout";
import { useStore } from "./state/store";
import { DragLayer } from "./components/pane/dnd";
import { actionFor, type Action } from "./lib/keymap";
import { currentBindings } from "./state/keys";
import { nextScale } from "./lib/scale";
import { BrowserButton } from "./components/BrowserButton";
import { PlyfoldMark } from "./components/Logo";
import { isMac, primaryKey, useFullscreen } from "./lib/platform";
import { cn } from "./lib/utils";

// The Motion lab (tuning springs and the liquid motion) is a development tool: only in `npm run tauri dev` builds,
// and left out of release bundles entirely
const MotionLab = import.meta.env.DEV ? lazy(() => import("./components/MotionLab").then((m) => ({ default: m.MotionLab }))) : null;

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      // ⌘1–⌘9 focus panes in layout order (left to right, top to bottom); fixed, not in the keymap
      if (primaryKey(e) && !(isMac ? e.ctrlKey : e.metaKey) && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const slot = leaves(s.layout)[Number(e.code.slice(5)) - 1];
        if (slot !== undefined) {
          e.preventDefault();
          s.focusPane(slot);
        }
        return;
      }
      const action = actionFor(e, currentBindings());
      // ⌘U (attach) is handled by the focused composer
      if (!action || action === "attach") return;
      e.preventDefault();
      const shown = leaves(s.layout);
      const zoom = (d: number) => {
        const next = nextScale(s.settings.ui_scale ?? 100, d);
        if (next !== s.settings.ui_scale) void s.saveSettings({ ui_scale: next }).catch(() => {});
      };
      const step = (d: number) => s.focusPane(shown[(shown.indexOf(s.focusedPane) + d + shown.length) % shown.length]);
      const run: Record<Exclude<Action, "attach">, () => void> = {
        search: () => s.setSearchOpen(!s.searchOpen),
        find: () => {
          const id = s.panes[s.focusedPane];
          if (id && s.sessions[id]) s.toggleFind(id);
        },
        settings: () => (s.settingsView ? s.closeSettings() : s.openSettings()),
        toggleSidebar: () => s.toggleSidebar(),
        newSession: () => s.newDraft(),
        stop: () => {
          const id = s.panes[s.focusedPane];
          if (id) void s.cancel(id);
        },
        // The ¥ key on Japanese keyboards counts as \ (see lib/keymap.ts)
        splitRight: () => s.splitFocused("right"),
        splitDown: () => s.splitFocused("bottom"),
        evenLayout: () => s.evenLayout(),
        closePane: () => s.paneCount > 1 && s.removePane(s.focusedPane),
        focusNext: () => step(1),
        focusPrev: () => step(-1),
        zoomIn: () => zoom(1),
        zoomOut: () => zoom(-1),
        zoomReset: () => void s.saveSettings({ ui_scale: 100 }).catch(() => {}),
        // The focused session's Git and changes view
        openDiff: () => {
          const id = s.panes[s.focusedPane];
          if (id && s.sessions[id]?.record.repo_path) s.openDiff(id);
        },
        // The focused session's side chat: open it, or put the cursor in it when it is open (closing clears it, so only the × button does)
        sideChat: () => {
          const id = s.panes[s.focusedPane];
          const v = id ? s.sessions[id] : undefined;
          if (!id || !v || !v.record.acp_session_id || v.record.agent === "gemini") return;
          const side = s.sideChats[id];
          if (!side) void s.openSideChat(id);
          else if (side.id) s.insertIntoComposer(side.id, "");
        },
      };
      run[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const t = useT();
  const init = useStore((s) => s.init);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  // Settings → Reduce motion: "system" follows macOS
  const reduceMotion = useStore((s) => s.settings.reduce_motion);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const sidebarResizing = useStore((s) => s.sidebarResizing);
  const focusedRepo = useStore((s) => {
    const id = s.panes[s.focusedPane];
    return id ? (s.sessions[id]?.record.repo_path ?? null) : null;
  });
  const fullscreen = useFullscreen();
  // In full screen, macOS takes an Esc the page did not handle as "exit full screen". Esc closes menus, the find bar,
  // previews and the like here, so in full screen it is always marked handled: on reaching its target, after the
  // menus' own handling (which runs while it travels down) and before any handler that might stop it on the way up.
  // Leave full screen with ⌃⌘F or the window button
  useEffect(() => {
    if (!isMac || !fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || !e.target) return;
      e.target.addEventListener("keydown", (ev) => ev.preventDefault(), { once: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);
  useShortcuts();
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <MotionConfig reducedMotion={reduceMotion === "reduce" ? "always" : "user"}>
      <TooltipProvider>
        <div className="flex h-full flex-col">
          {/* On macOS the window's traffic lights sit over the header's left end (not in full screen, where they are
              hidden); Windows has a regular title bar */}
          <header
            data-tauri-drag-region
            className={cn("relative flex h-10 shrink-0 items-center gap-2 border-b pr-2", isMac && !fullscreen ? "pl-[84px]" : "pl-2")}
          >
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
            {/* The repository of the focused session, or the app's name and mark when there is none. Centred in the
                window like a macOS title (clicks pass through to the drag region; long names are cut off) */}
            <span
              data-tauri-drag-region
              className="pointer-events-none absolute top-1/2 left-1/2 flex max-w-[40%] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 font-medium"
            >
              {!focusedRepo && <PlyfoldMark className="size-4 shrink-0" />}
              <span className="truncate">{focusedRepo ? repoName(focusedRepo) : "Plyfold"}</span>
            </span>
            <span data-tauri-drag-region className="grow" />
            <BrowserButton />
            <Notifications />
          </header>

          <div className="flex min-h-0 grow">
            {/* Closing the sidebar animates the clipping width only; the sidebar keeps its own width so its text never reflows.
                While closed it is inert, so focus and screen readers skip it */}
            <motion.div
              initial={false}
              animate={{ width: sidebarOpen ? sidebarWidth : 0 }}
              transition={sidebarResizing ? { duration: 0 } : smooth}
              inert={!sidebarOpen}
              className="flex shrink-0 overflow-hidden"
            >
              <Sidebar />
            </motion.div>
            <PaneGrid />
          </div>
          {!inTauri && <p className="fixed right-3 bottom-3 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{t("app.browserOnly")}</p>}
        </div>
        <GooDefs />
        <ProfilesView />
        <SettingsView />
        <LiquidStage />
        <SearchCard />
        <ImagePreview />
        <DragLayer />
        {MotionLab && (
          <Suspense fallback={null}>
            <MotionLab />
          </Suspense>
        )}
      </TooltipProvider>
    </MotionConfig>
  );
}
