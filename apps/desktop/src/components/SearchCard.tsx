import { KeyRound, ListChecks, Plus, Search, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { ProviderLogo } from "./icons";

interface Entry {
  key: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  run: () => void;
}

/** ⌘K の検索カード。サイドバーの方から飛び出し、伸びて揺れながら開く */
export function SearchCard() {
  const open = useStore((s) => s.searchOpen);
  const sessions = useStore((s) => s.sessions);
  const { setSearchOpen, openInPane, setNewSessionOpen, cancel } = useStore.getState();
  const focusedId = useStore((s) => s.panes[s.focusedPane]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const close = () => setSearchOpen(false);
  const entries = useMemo<{ title: string; items: Entry[] }[]>(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    const recent = Object.values(sessions)
      .sort((a, b) => b.record.updated_at - a.record.updated_at)
      .filter((v) => match(v.record.title) || match(v.record.profile))
      .slice(0, needle ? 8 : 4)
      .map<Entry>((v) => ({
        key: v.record.id,
        label: v.record.title,
        hint: repoName(v.record.repo_path),
        icon: <ProviderLogo agent={v.record.agent} className="text-muted-foreground" />,
        run: () => void openInPane(v.record.id),
      }));
    const commands: Entry[] = [
      { key: "new", label: "新しいセッション", hint: "⌘N", icon: <Plus className="size-3.5" />, run: () => setNewSessionOpen(true) },
      { key: "mode", label: "mode を切り替え", hint: "⇧⇥", icon: <ListChecks className="size-3.5" />, run: () => {} },
      { key: "stop", label: "作業中のターンを停止", hint: "⌘.", icon: <Square className="size-3.5" />, run: () => focusedId && void cancel(focusedId) },
      { key: "profiles", label: "プロファイル", hint: "⌘,", icon: <KeyRound className="size-3.5" />, run: () => {} },
    ].filter((c) => match(c.label));
    return [
      { title: "最近のセッション", items: recent },
      { title: "コマンド", items: commands },
    ].filter((g) => g.items.length > 0);
  }, [q, sessions, focusedId, openInPane, setNewSessionOpen, cancel]);

  const flat = entries.flatMap((g) => g.items);
  const choose = (e: Entry | undefined) => {
    if (!e) return;
    close();
    e.run();
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.button
            type="button"
            aria-label="検索を閉じる"
            onClick={close}
            className="absolute inset-0 cursor-default bg-black/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            role="dialog"
            aria-label="検索"
            initial={{ opacity: 0, x: -140, y: -40, scaleX: 0.15, scaleY: 0.06 }}
            animate={{ opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 }}
            exit={{ opacity: 0, scale: 0.9, y: -8 }}
            transition={{ type: "spring", stiffness: 380, damping: 18, mass: 0.9 }}
            style={{ transformOrigin: "0 0" }}
            className="absolute top-24 left-1/2 -ml-[280px] flex w-[560px] flex-col rounded-[14px] border bg-card/85 shadow-[0_16px_48px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.06)] backdrop-blur-2xl backdrop-saturate-150"
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") choose(flat[sel]);
            }}
          >
            <div className="flex h-11 items-center gap-2.5 border-b px-3.5">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <input
                ref={input}
                aria-label="セッションやコマンドを検索"
                placeholder="セッションやコマンドを検索"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSel(0);
                }}
                className="grow bg-transparent text-base outline-none placeholder:text-muted-foreground"
              />
              <kbd className="rounded bg-muted px-1.5 font-mono text-xs text-muted-foreground">esc</kbd>
            </div>
            <div className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto p-2">
              {flat.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">見つかりません</p>}
              {entries.map((g) => (
                <div key={g.title} className="flex flex-col gap-0.5">
                  <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{g.title}</div>
                  {g.items.map((e) => {
                    const i = flat.indexOf(e);
                    return (
                      <button
                        key={e.key}
                        type="button"
                        onMouseEnter={() => setSel(i)}
                        onClick={() => choose(e)}
                        className={cn("flex h-8 w-full items-center gap-2.5 rounded-lg px-2", i === sel && "bg-muted")}
                      >
                        <span className="flex text-muted-foreground">{e.icon}</span>
                        <span className="grow truncate text-left">{e.label}</span>
                        <span className="font-mono text-xs text-muted-foreground">{e.hint}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex h-8 items-center gap-4 border-t px-3.5 text-xs text-muted-foreground">
              <span>
                <kbd className="font-mono">↑↓</kbd> 移動
              </span>
              <span>
                <kbd className="font-mono">⏎</kbd> 開く
              </span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
