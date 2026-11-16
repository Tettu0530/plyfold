import { ChevronRight, KeyRound, Plus, Search, Settings } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";

import { age, repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { ProviderLogo, STATUS, StatusIcon } from "./icons";
import { Keys } from "./Keys";
import { SessionMenu } from "./SessionMenu";
import { liquidAnchor } from "./liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMovingAnchors } from "./liquid/stage";
import { smooth, snappy } from "./motion";

export function Sidebar() {
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
  // 実体は出発点（ボタンや行）だけの裏から出る。実体はサイドバーの地より上（55）、出発点はその上（57）
  const searchLayer = useStore((s) => s.searchLayerActive);
  const unread = useStore((s) => s.unread);
  const active = useLiquidActiveAnchors();
  // 右クリックのメニューは途中で行を実体の下へ下げる。下げても、動いているあいだは選択中の色で残す
  const moving = useLiquidMovingAnchors();
  const searchOpen = useStore((s) => s.searchOpen);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  // 名前を変えている行
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameSession = useStore((s) => s.renameSession);

  // リポジトリごとにまとめ、新しく更新されたものから
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
    <nav aria-label="セッション" className="relative flex w-60 shrink-0 flex-col border-r bg-sidebar">
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
          <span className="grow text-left">新しいセッション</span>
          <Keys keys={["cmd", "n"]} />
        </motion.button>
        <motion.button
          ref={liquidAnchor("search")}
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          // 出発点: 押すとぽんと膨らみ、開いているあいだは暗くせず選択中の色で残す（どこから出たかを示す）
          animate={searchOpen ? { scale: [1, 1.06, 1] } : { scale: 1 }}
          transition={snappy}
          className={cn(
            "relative flex h-7 items-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
            searchLayer && "z-[57]",
            searchOpen && "bg-accent text-foreground",
          )}
        >
          <Search className="size-4" aria-hidden />
          <span className="grow text-left">検索</span>
          <Keys keys={["cmd", "k"]} />
        </motion.button>
      </div>

      <div className="flex min-h-0 grow flex-col overflow-y-auto px-2">
        {groups.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">セッションはまだありません</p>}
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
                      onClick={(e) => {
                        e.preventDefault();
                        void openInPane(r.id, undefined, `session:${r.id}`);
                      }}
                      className={cn(
                        "relative mb-1 flex flex-col gap-1 rounded-lg p-2 text-foreground no-underline hover:bg-accent data-[state=open]:bg-accent",
                        (open.has(r.id) || moving.has(`session:${r.id}`)) && "bg-accent",
                        active.has(`session:${r.id}`) && "z-[57]",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ProviderLogo agent={r.agent} className="text-muted-foreground" />
                        {renaming === r.id ? (
                          <input
                            aria-label="セッションの名前"
                            defaultValue={r.title}
                            autoFocus
                            onFocus={(e) => e.currentTarget.select()}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
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
                        {unread[r.id] && <span role="img" aria-label="見ていない知らせがあります" className={cn("size-1.5 shrink-0 rounded-full", unread[r.id].error ? "bg-error" : "bg-foreground")} />}
                        <span className={cn("flex shrink-0 items-center gap-1 text-xs", quiet ? "text-muted-foreground" : st.color)}>
                          <StatusIcon status={r.status} className="size-3" />
                          {st.label}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 pl-[22px] text-xs text-muted-foreground">
                        <span className="min-w-0 grow truncate">{r.profile === r.agent ? "default" : r.profile}</span>
                        <span className="font-mono tabular">{age(r.updated_at)}</span>
                      </span>
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
          <span className="grow text-left">プロファイル</span>
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
          <span className="grow text-left">設定</span>
          <Keys keys={["cmd", ","]} />
        </motion.button>
      </div>
    </nav>
  );
}
