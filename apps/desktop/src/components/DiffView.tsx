import { ChevronLeft, GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import { parsePatch, toSplit, type FilePatch, type PatchLine } from "@/lib/patch";
import type { Diff } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { ProviderLogo } from "./icons";
import { Keys } from "./Keys";
import { useLiquidRevealed } from "./liquid/stage";
import { Segmented } from "./Segmented";

type View = "unified" | "split";

const BADGE: Record<FilePatch["status"], { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-working", label: "追加" },
  deleted: { letter: "D", className: "text-error", label: "削除" },
  modified: { letter: "M", className: "text-muted-foreground", label: "変更" },
  renamed: { letter: "R", className: "text-muted-foreground", label: "名前の変更" },
};

/** 差分の画面。サイドバーとペインの上に重なり、ペインの差分の数から飛び出して広がる */
export function DiffView() {
  const diff = useStore((s) => s.diff);
  const view = useStore((s) => (diff ? s.sessions[diff.id] : undefined));
  const closeDiff = useStore((s) => s.closeDiff);
  const revealed = useLiquidRevealed("diff");
  const [data, setData] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<View>("unified");
  const id = diff?.id;

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    setSel(0);
    api
      .sessionDiff(id)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDiff();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, closeDiff]);

  const files = useMemo(() => {
    if (!data) return [];
    const parsed = parsePatch(data.patch);
    // 数はエンジンの集計（--numstat）を使い、行はパッチから引く
    return data.files.map((f) => ({ stat: f, patch: parsed.find((p) => p.path === f.path) }));
  }, [data]);
  const total = files.reduce((a, f) => ({ add: a.add + f.stat.added, del: a.del + f.stat.removed }), { add: 0, del: 0 });

  if (!diff || !view) return null;
  const r = view.record;
  const current = files[Math.min(sel, files.length - 1)];
  const visible = revealed && !diff.closing;

  return (
    <div
      data-diff-view
      role="dialog"
      aria-label={`差分: ${r.title}`}
      aria-hidden={!visible}
      className={cn("fixed inset-x-0 top-10 bottom-0 z-40 flex flex-col bg-background transition-opacity duration-150", visible ? "opacity-100" : "pointer-events-none opacity-0")}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-3 pl-2">
        <button type="button" onClick={closeDiff} className="flex h-7 items-center gap-1 rounded-lg pr-2 pl-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronLeft className="size-4" aria-hidden />
          ペインに戻る
          <Keys keys={["esc"]} />
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="truncate font-medium">{r.title}</span>
        <span className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          <ProviderLogo agent={r.agent} className="size-3" />
          {r.profile === r.agent ? "default" : r.profile}
        </span>
        <span className="grow" />
        {r.branch && (
          <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <GitBranch className="size-3.5" aria-hidden />
            {r.branch}
            {r.base_ref && <span>← {r.base_ref.slice(0, 7)}</span>}
          </span>
        )}
      </div>

      <div className="flex min-h-0 grow">
        <aside aria-label="変更したファイル" className="flex w-[300px] shrink-0 flex-col border-r bg-sidebar">
          <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-xs">
            <span className="font-medium text-muted-foreground">{data ? `変更 ${files.length} ファイル` : "読み込み中"}</span>
            <span className="grow" />
            {data && (
              <span className="font-mono tabular">
                <span className="text-working">+{total.add}</span> <span className="text-error">−{total.del}</span>
              </span>
            )}
          </div>
          <div role="listbox" aria-label="ファイル" className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto px-2 pb-2">
            {files.map((f, i) => {
              const b = BADGE[f.patch?.status ?? (f.stat.untracked ? "added" : "modified")];
              return (
                <button
                  key={f.stat.path}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  onClick={() => setSel(i)}
                  className={cn("flex h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 hover:bg-accent", i === sel && "bg-muted")}
                >
                  <span title={b.label} className={cn("w-4 shrink-0 font-mono text-xs font-medium", b.className)}>
                    {b.letter}
                  </span>
                  <span className="min-w-0 grow truncate text-left font-mono text-xs" title={f.stat.path}>
                    {f.stat.path}
                  </span>
                  <span className="flex shrink-0 gap-1.5 font-mono text-xs tabular">
                    {f.stat.binary ? (
                      <span className="text-muted-foreground">bin</span>
                    ) : (
                      <>
                        <span className="text-working">+{f.stat.added}</span>
                        <span className="text-error">−{f.stat.removed}</span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex min-w-0 grow flex-col">
          {error && <p className="p-4 text-xs whitespace-pre-wrap text-error">差分を取れませんでした: {error}</p>}
          {data && files.length === 0 && <p className="p-4 text-xs text-muted-foreground">{r.base_ref ? `${r.base_ref.slice(0, 7)} から変更はありません` : "変更はありません"}</p>}
          {current && (
            <>
              <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
                <span className="truncate font-mono">{current.stat.path}</span>
                <span className="shrink-0 font-mono text-xs tabular">
                  <span className="text-working">+{current.stat.added}</span> <span className="text-error">−{current.stat.removed}</span>
                </span>
                <span className="grow" />
                <Segmented<View>
                  label="表示"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "unified", label: "統合" },
                    { value: "split", label: "左右" },
                  ]}
                />
              </div>
              <div className="min-h-0 grow overflow-auto py-1 font-mono text-xs leading-5">
                {current.stat.binary || current.patch?.binary ? (
                  <p className="px-4 py-2 text-muted-foreground">バイナリのファイルなので、中身は表示しません</p>
                ) : !current.patch ? (
                  <p className="px-4 py-2 text-muted-foreground">このファイルの差分の行が見つかりません</p>
                ) : mode === "unified" ? (
                  <Unified lines={current.patch.lines} />
                ) : (
                  <Split lines={current.patch.lines} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

const ROW: Record<PatchLine["kind"], string> = {
  ctx: "text-foreground/85",
  add: "bg-working/10 text-foreground",
  del: "bg-error/10 text-foreground",
  hunk: "mt-2 bg-card text-muted-foreground first:mt-0",
  note: "text-muted-foreground",
};

function Num({ n }: { n: number | null }) {
  return <span className="inline-block w-10 shrink-0 pr-2 text-right text-muted-foreground/70 select-none">{n ?? ""}</span>;
}

function Unified({ lines }: { lines: PatchLine[] }) {
  return (
    <div className="min-w-max">
      {lines.map((l, i) => (
        <div key={i} className={cn("flex pr-4 pl-1", ROW[l.kind])}>
          <Num n={l.old} />
          <Num n={l.new} />
          <span className="w-4 shrink-0 text-muted-foreground select-none">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
          <span className="whitespace-pre">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function Split({ lines }: { lines: PatchLine[] }) {
  const rows = toSplit(lines);
  const cell = (l: PatchLine | null, side: "old" | "new") => (
    <div className={cn("flex min-w-0 pr-3 pl-1", l ? ROW[l.kind] : "bg-card/40")}>
      <Num n={l ? l[side] : null} />
      <span className="min-w-0 overflow-hidden whitespace-pre">{l?.text ?? ""}</span>
    </div>
  );
  return (
    <div>
      {rows.map((r, i) =>
        r.kind === "hunk" ? (
          <div key={i} className={cn("flex pr-4 pl-1", ROW.hunk)}>
            <span className="w-12 shrink-0" />
            <span className="whitespace-pre">{r.left?.text}</span>
          </div>
        ) : (
          <div key={i} className="grid grid-cols-2 divide-x divide-border">
            {cell(r.left, "old")}
            {cell(r.right, "new")}
          </div>
        ),
      )}
    </div>
  );
}
