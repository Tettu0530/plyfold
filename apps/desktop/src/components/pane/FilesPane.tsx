import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, FileText, FolderOpen, ImageIcon, PanelTopOpen, Pencil, X } from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";

import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { isMac, isWindows } from "@/lib/platform";
import type { TextFile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { touchedFiles, type TouchedFile } from "@/state/paneData";
import { filesSessionOf, useStore } from "@/state/store";
import { isImagePreviewOpen, useFileImage } from "../ImagePreview";
import { Thumb } from "./Attachments";
import { ColumnResizer, NARROW_PX, useColumnWidth, useWidth } from "./GitPane";
import { startDrag } from "./dnd";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";
import { relative } from "./PaneTools";

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** Lines shown at most; a longer file says so (rendering more makes scrolling heavy) */
const MAX_LINES = 5000;

/**
 * The files a session read or edited, as a pane beside it (it opens out of the touched-files button).
 * Wide: the list in a resizable column, the picked file's contents beside it. Narrow: the list, then the file in its
 * place. The file can be shown in Finder, opened in the editor, or its path copied
 */
export function FilesPane({ index, id }: { index: number; id: string }) {
  const t = useT();
  const sid = filesSessionOf(id);
  const view = useStore((s) => s.sessions[sid]);
  const focused = useStore((s) => s.focusedPane === index);
  const { focusPane, closePane } = useStore.getState();
  const pane = useRef<HTMLElement>(null);
  const width = useWidth(pane);
  const narrow = width < NARROW_PX;
  const [columnWidth, setColumnWidth] = useColumnWidth("plyfold.filesColumnWidth");
  const items = view?.transcript.items;
  const files = useMemo(() => (items ? touchedFiles(items) : []), [items]);
  const [picked, setPicked] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  if (!view) {
    return (
      <section ref={pane} className="flex min-w-0 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <p>{t("diff.sessionGone")}</p>
        <button type="button" onClick={() => closePane(index)} className="rounded-md px-2 py-1 hover:bg-accent hover:text-foreground">
          {t("pane.closePane")}
        </button>
      </section>
    );
  }
  const r = view.record;
  const base = r.worktree_path ?? r.repo_path;
  const current = files.find((f) => f.path === picked) ?? files[0];
  const pick = (f: TouchedFile) => {
    setPicked(f.path);
    if (narrow) setReading(true);
  };
  const at = current ? files.findIndex((f) => f.path === current.path) : -1;
  // Previous or next file in the list (stops at the ends)
  const step = (d: number) => {
    const next = files[at + d];
    if (next) setPicked(next.path);
  };
  const stepping = { index: at, count: files.length, onStep: step };

  const list = (
    <FileList
      files={files}
      base={base}
      sel={narrow ? null : (current?.path ?? null)}
      onPick={pick}
      onMove={(d) => {
        const i = files.findIndex((f) => f.path === current?.path);
        const next = files[Math.min(files.length - 1, Math.max(0, i + d))];
        if (next) setPicked(next.path);
      }}
    />
  );

  return (
    <section
      ref={pane}
      aria-label={t("pane.filesOf", { title: r.title })}
      onMouseDown={() => focusPane(index)}
      className={cn("@container flex min-w-0 flex-col", focused && "bg-white/[0.01]")}
    >
      {focused && (!narrow || reading) && <StepKeys onStep={step} />}
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(e) => startDrag(e, () => ({ kind: "pane", slot: index, title: t("pane.filesOf", { title: r.title }), agent: r.agent }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b pr-1.5 pl-3"
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{r.title}</span>
          <span className="hidden truncate text-xs text-muted-foreground @[22rem]:inline">{t("pane.files")}</span>
          <span className="grow" />
          {files.length > 0 && <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">{files.length}</span>}
          <button
            type="button"
            aria-label={t("pane.closePane")}
            onClick={() => closePane(index)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </PaneMenu>

      {files.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">{t("pane.filesEmpty")}</p>
      ) : narrow ? (
        reading && current ? (
          <FileView file={current} base={base} onBack={() => setReading(false)} {...stepping} />
        ) : (
          <div className="flex min-h-0 grow flex-col overflow-y-auto pt-2">{list}</div>
        )
      ) : (
        <div className="flex min-h-0 grow">
          <div className="relative flex shrink-0" style={{ width: Math.min(columnWidth, Math.round(width * 0.6)) }}>
            <aside aria-label={t("pane.files")} className="flex min-w-0 grow flex-col overflow-y-auto border-r pt-2">
              {list}
            </aside>
            <ColumnResizer width={columnWidth} onChange={setColumnWidth} />
          </div>
          <div className="flex min-w-0 grow flex-col">{current ? <FileView file={current} base={base} {...stepping} /> : null}</div>
        </div>
      )}
    </section>
  );
}

function FileList({
  files,
  base,
  sel,
  onPick,
  onMove,
}: {
  files: TouchedFile[];
  base: string | null;
  sel: string | null;
  onPick: (f: TouchedFile) => void;
  onMove: (d: number) => void;
}) {
  const t = useT();
  return (
    <div
      role="listbox"
      aria-label={t("pane.files")}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (sel !== null && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          onMove(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
      className="flex flex-col gap-0.5 px-2 pb-2 outline-none"
    >
      {files.map((f) => (
        <button
          key={f.path}
          type="button"
          role="option"
          aria-selected={f.path === sel}
          title={f.path}
          onClick={() => onPick(f)}
          className={cn("flex h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left hover:bg-accent", f.path === sel && "bg-muted")}
        >
          {f.edited ? (
            <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("pane.fileEdited")} />
          ) : IMAGE.test(f.path) ? (
            <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("pane.fileRead")} />
          ) : (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("pane.fileRead")} />
          )}
          <span className="min-w-0 grow truncate font-mono text-xs">{relative(f.path, base)}</span>
          {f.count > 1 && <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">{f.count}</span>}
        </button>
      ))}
    </div>
  );
}

const revealLabel = isMac ? "pane.revealMac" : isWindows ? "pane.revealWindows" : "pane.revealLinux";

/** One file: its path and actions, then an image or the text with line numbers. With onBack (narrow), a way back */
/** ← and → step through the files while this pane is focused, unless typing or the image preview has them */
function StepKeys({ onStep }: { onStep: (d: number) => void }) {
  const latest = useRef(onStep);
  latest.current = onStep;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable=true]") || isImagePreviewOpen()) return;
      // Text selected in the file: the arrows are left alone
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      latest.current(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

function FileView({
  file,
  base,
  onBack,
  index,
  count,
  onStep,
}: {
  file: TouchedFile;
  base: string | null;
  onBack?: () => void;
  index: number;
  count: number;
  onStep: (d: number) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const image = IMAGE.test(file.path);
  useEffect(() => {
    setCopied(false);
    setError(null);
  }, [file.path]);
  const act = (p: Promise<unknown>) => void p.catch((e) => setError(String(e)));
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md pr-2 pl-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {t("diff.backToFiles")}
          </button>
        )}
        <span className={cn("min-w-0 truncate font-mono text-xs", !onBack && "pl-2")} title={file.path}>
          {relative(file.path, base)}
        </span>
        <span className="grow" />
        {count > 1 && (
          <span className="flex shrink-0 items-center">
            <Action label={t("pane.previousFile")} disabled={index <= 0} onClick={() => onStep(-1)}>
              <ChevronLeft className="size-3.5" aria-hidden />
            </Action>
            <span className="px-0.5 font-mono text-xs text-muted-foreground tabular">
              {index + 1} / {count}
            </span>
            <Action label={t("pane.nextFile")} disabled={index >= count - 1} onClick={() => onStep(1)}>
              <ChevronRight className="size-3.5" aria-hidden />
            </Action>
          </span>
        )}
        {inTauri && (
          <>
            <Action label={t(revealLabel)} onClick={() => act(api.revealFile(file.path))}>
              <FolderOpen className="size-3.5" aria-hidden />
            </Action>
            <Action label={t("pane.openFile")} onClick={() => act(api.openFileInEditor(file.path))}>
              <PanelTopOpen className="size-3.5" aria-hidden />
            </Action>
          </>
        )}
        <Action
          label={copied ? t("pane.pathCopied") : t("pane.copyPath")}
          onClick={() =>
            act(
              navigator.clipboard.writeText(file.path).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }),
            )
          }
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        </Action>
      </div>
      {error && <p className="px-4 pt-3 text-xs whitespace-pre-wrap text-error">{error}</p>}
      {image ? <ImageView path={file.path} /> : <TextView key={file.path} path={file.path} />}
    </div>
  );
}

function Action({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ImageView({ path }: { path: string }) {
  const t = useT();
  const src = useFileImage(path);
  return (
    <div className="flex min-h-0 grow items-center justify-center overflow-auto p-6">
      {src ? (
        <Thumb src={src} name={path.split(/[\\/]/).pop() ?? path} anchor={`files-img:${path}`} className="max-h-[70vh] max-w-full object-contain" />
      ) : src === null ? (
        <p className="text-xs text-muted-foreground">{t("pane.fileUnreadable", { error: path })}</p>
      ) : null}
    </div>
  );
}

function TextView({ path }: { path: string }) {
  const t = useT();
  const [file, setFile] = useState<TextFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    api.readTextFile(path).then(
      (f) => alive && setFile(f),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [path]);
  const lines = useMemo(() => (file?.text != null ? file.text.replace(/\n$/, "").split("\n") : []), [file]);
  if (error) return <p className="px-4 py-3 text-xs whitespace-pre-wrap text-error">{t("pane.fileUnreadable", { error })}</p>;
  if (!file) return null;
  if (file.text === null) return <p className="px-4 py-3 text-xs text-muted-foreground">{t("pane.fileBinary")}</p>;
  if (file.text === "") return <p className="px-4 py-3 text-xs text-muted-foreground">{t("pane.fileEmpty")}</p>;
  const shown = lines.slice(0, MAX_LINES);
  const digits = String(shown.length).length;
  return (
    <div className="min-h-0 grow overflow-auto py-1 font-mono text-xs leading-5 select-text">
      {(file.truncated || lines.length > MAX_LINES) && (
        <p className="px-4 pb-1 font-sans text-muted-foreground">
          {lines.length > MAX_LINES ? t("pane.fileLines", { count: MAX_LINES }) : t("pane.fileTruncated")}
        </p>
      )}
      <div className="w-max min-w-full">
        {shown.map((l, i) => (
          <div key={i} className="flex hover:bg-white/[0.02]">
            <span className="shrink-0 pr-3 pl-4 text-right text-muted-foreground tabular select-none" style={{ width: `${digits + 3}ch` }}>
              {i + 1}
            </span>
            <span className="pr-4 whitespace-pre">{l || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
