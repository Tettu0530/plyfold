import { Equal, GitCompare, KeyRound, ListChecks, MessageSquare, PanelBottom, PanelRight, Plus, Search, Settings, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MIN_QUERY, searchSessions, type SessionHit } from "@/state/find";
import { useStore, isListed, type SessionView } from "@/state/store";
import { fromHistory, type TranscriptItem } from "@/state/transcript";
import { ProviderLogo } from "./icons";
import { Keys } from "./Keys";
import { useLiquidMorph } from "./liquid/liquid";
import { smooth } from "./motion";
import { isImeKey } from "@/lib/keys";
import { keysOf } from "@/lib/keymap";
import { useBindings } from "@/state/keys";

interface Entry {
  key: string;
  label: string;
  keys?: string[];
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** Saved logs, keyed by session and its updated time, so typing again does not re-read them */
const historyCache = new Map<string, TranscriptItem[]>();

function loadHistory(v: SessionView): Promise<TranscriptItem[]> {
  const key = `${v.record.id}:${v.record.updated_at}`;
  const cached = historyCache.get(key);
  if (cached) return Promise.resolve(cached);
  return api.sessionHistory(v.record.id).then((events) => {
    const items = fromHistory(events).items;
    if (historyCache.size > 80) {
      const first = historyCache.keys().next().value;
      if (first) historyCache.delete(first);
    }
    historyCache.set(key, items);
    return items;
  });
}

/** The ⌘K search card. A blob splits off the sidebar's Search item like a droplet, travels over and expands */
export function SearchCard() {
  const t = useT();
  const bindings = useBindings();
  const open = useStore((s) => s.searchOpen);
  const sessions = useStore((s) => s.sessions);
  const { setSearchOpen, openInPane, newDraft, cancel, openSettings, openProfiles } = useStore.getState();
  const focusedId = useStore((s) => s.panes[s.focusedPane]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [messageHits, setMessageHits] = useState<SessionHit[]>([]);
  const [searching, setSearching] = useState(false);
  const req = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const liquidStyle = useStore((s) => s.liquidStyle);
  const liquidLag = useStore((s) => s.liquidLag);
  const { revealed, mounted, layer } = useLiquidMorph(open, {
    anchor: "search",
    target: card,
    radius: 14,
    anchorRadius: 8,
    color: "#262626",
    style: liquidStyle,
    zIndex: 55,
    sizeLag: liquidLag,
  });
  const setSearchLayerActive = useStore((s) => s.setSearchLayerActive);
  useEffect(() => setSearchLayerActive(mounted), [mounted, setSearchLayerActive]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);
  useEffect(() => {
    if (revealed) input.current?.focus();
  }, [revealed]);

  const listed = useMemo(
    () =>
      Object.values(sessions)
        .filter(isListed)
        .sort((a, b) => b.record.updated_at - a.record.updated_at),
    [sessions],
  );
  // Message hits start at two characters. A newer keystroke drops the previous search
  useEffect(() => {
    const needle = q.trim();
    if (!open || needle.length < MIN_QUERY) {
      setMessageHits([]);
      setSearching(false);
      return;
    }
    const mine = ++req.current;
    const timer = setTimeout(() => {
      setSearching(true);
      void searchSessions(
        listed.map((v) => ({ id: v.record.id, title: v.record.title, items: v.historyLoaded ? v.transcript.items : null })),
        needle,
        (id) => {
          const v = listed.find((s) => s.record.id === id);
          return v ? loadHistory(v) : Promise.resolve([]);
        },
        () => req.current === mine,
      ).then((hits) => {
        if (req.current !== mine) return;
        setMessageHits(hits);
        setSearching(false);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [q, open, listed]);

  const close = () => setSearchOpen(false);
  const entries = useMemo<{ title: string; items: Entry[] }[]>(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    const recent = listed
      .filter((v) => match(v.record.title) || match(v.record.profile))
      .slice(0, needle ? 8 : 4)
      .map<Entry>((v) => ({
        key: v.record.id,
        label: v.record.title,
        hint: repoName(v.record.repo_path),
        icon: <ProviderLogo agent={v.record.agent} className="text-muted-foreground" />,
        run: () => void openInPane(v.record.id),
      }));
    const messages: Entry[] =
      needle.length < MIN_QUERY
        ? []
        : messageHits.map((h) => ({
            key: `msg:${h.sessionId}:${h.itemIndex}`,
            label: h.excerpt,
            hint: h.title,
            icon: <MessageSquare className="size-3.5" />,
            run: () => {
              const query = q.trim();
              void openInPane(h.sessionId)
                .catch(() => {})
                .then(() => useStore.getState().showFind(h.sessionId, query, h.matchIndex));
            },
          }));
    const commands: Entry[] = [
      { key: "new", label: t("search.newSession"), keys: keysOf(bindings.newSession), icon: <Plus className="size-3.5" />, run: () => newDraft() },
      { key: "mode", label: t("search.switchMode"), keys: ["shift", "tab"], icon: <ListChecks className="size-3.5" />, run: () => {} },
      {
        key: "stop",
        label: t("search.stopTurn"),
        keys: keysOf(bindings.stop),
        icon: <Square className="size-3.5" />,
        run: () => focusedId && void cancel(focusedId),
      },
      // The focused session's changes (worktree sessions only)
      ...(focusedId && sessions[focusedId]?.record.worktree_path
        ? [
            {
              key: "diff",
              label: t("pane.viewChanges"),
              keys: keysOf(bindings.openDiff),
              icon: <GitCompare className="size-3.5" />,
              run: () => useStore.getState().openDiff(focusedId),
            },
          ]
        : []),
      {
        key: "splitRight",
        label: t("pane.splitRight"),
        keys: keysOf(bindings.splitRight),
        icon: <PanelRight className="size-3.5" />,
        run: () => useStore.getState().splitFocused("right"),
      },
      {
        key: "splitDown",
        label: t("pane.splitDown"),
        keys: keysOf(bindings.splitDown),
        icon: <PanelBottom className="size-3.5" />,
        run: () => useStore.getState().splitFocused("bottom"),
      },
      {
        key: "even",
        label: t("pane.evenLayout"),
        keys: keysOf(bindings.evenLayout),
        icon: <Equal className="size-3.5" />,
        run: () => useStore.getState().evenLayout(),
      },
      { key: "settings", label: t("search.settings"), keys: keysOf(bindings.settings), icon: <Settings className="size-3.5" />, run: () => openSettings() },
      { key: "profiles", label: t("search.profiles"), icon: <KeyRound className="size-3.5" />, run: () => openProfiles() },
    ].filter((c) => match(c.label));
    return [
      { title: t("search.recent"), items: recent },
      { title: t("search.messages"), items: messages },
      { title: t("search.commands"), items: commands },
    ].filter((g) => g.items.length > 0);
  }, [q, listed, messageHits, focusedId, sessions, openInPane, newDraft, cancel, openSettings, openProfiles, t, bindings]);

  const flat = entries.flatMap((g) => g.items);
  const choose = (e: Entry | undefined) => {
    if (!e) return;
    close();
    e.run();
  };

  return (
    <>
      {layer}
      <AnimatePresence>
        {open && (
          <motion.button
            key="backdrop"
            type="button"
            aria-label={t("search.close")}
            onClick={close}
            className="fixed inset-0 z-50 cursor-default bg-black/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: smooth }}
            exit={{ opacity: 0, transition: smooth }}
          />
        )}
      </AnimatePresence>
      {mounted && (
        <div
          ref={card}
          role="dialog"
          aria-label={t("search.label")}
          aria-hidden={!revealed}
          className={cn(
            "fixed top-24 left-1/2 z-[70] -ml-[280px] flex w-[560px] flex-col rounded-[14px] border bg-card/85 shadow-[0_16px_48px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.06)] backdrop-blur-2xl backdrop-saturate-150 transition-opacity duration-150",
            revealed ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, flat.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && !isImeKey(e)) choose(flat[sel]);
          }}
        >
          <div className="flex h-11 items-center gap-2.5 border-b px-3.5">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            <input
              ref={input}
              aria-label={t("search.placeholder")}
              placeholder={t("search.placeholder")}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              className="grow bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            <Keys keys={["esc"]} />
          </div>
          <div className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto p-2">
            {searching && messageHits.length === 0 && q.trim().length >= MIN_QUERY && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("search.searching")}</p>
            )}
            {flat.length === 0 && !searching && <p className="px-2 py-3 text-xs text-muted-foreground">{t("search.noResults")}</p>}
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
                      {e.keys ? <Keys keys={e.keys} /> : <span className="max-w-[40%] truncate text-xs text-muted-foreground">{e.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex h-8 items-center gap-4 border-t px-3.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Keys keys={["up", "down"]} />
              {t("search.navigate")}
            </span>
            <span className="flex items-center gap-1.5">
              <Keys keys={["enter"]} />
              {t("search.open")}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
