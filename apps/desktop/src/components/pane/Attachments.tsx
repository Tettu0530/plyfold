// 入力欄に添えるもの: 画像は貼り付け（⌘V）、ファイルはペインに落とす。送る前に並べて見せ、× で外せる
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, ImageIcon, Paperclip, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";

import { inTauri } from "@/lib/api";
import { fromPath, readImage, type Attached } from "@/lib/attachments";
import { addDropTarget } from "@/lib/drop";
import { cn } from "@/lib/utils";
import { bouncy, smooth } from "../motion";
import { Keys } from "../Keys";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";

export function useAttachments() {
  const [items, setItems] = useState<Attached[]>([]);
  const [over, setOver] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      addDropTarget({
        // ペインのどこに落としても、そのペインの入力欄に添える
        el: () => boxRef.current?.closest<HTMLElement>("[data-pane-index]") ?? boxRef.current,
        onOver: setOver,
        onDrop: (paths) => setItems((a) => [...a, ...paths.map(fromPath)]),
      }),
    [],
  );
  const onPaste = (e: React.ClipboardEvent) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    // 文字も一緒なら、文字は普通に貼る
    if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
    void Promise.all(images.map(readImage)).then((read) => setItems((a) => [...a, ...read]));
  };
  /** macOS のファイルの選択を開いて添える（パスで渡すので、落としたときと同じ扱い） */
  const pick = async (kind: "file" | "image") => {
    if (!inTauri) return;
    const picked = await openDialog({
      multiple: true,
      directory: false,
      title: kind === "image" ? "添える画像" : "添えるファイル",
      ...(kind === "image" ? { filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] } : {}),
    });
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length) setItems((a) => [...a, ...paths.map(fromPath)]);
  };
  return {
    items,
    over,
    boxRef,
    onPaste,
    pick,
    remove: (key: string) => setItems((a) => a.filter((x) => x.key !== key)),
    clear: () => setItems([]),
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

function Chip({ a, onRemove }: { a: Attached; onRemove: () => void }) {
  const remove = (
    <button
      type="button"
      aria-label={`${a.preview.name} を外す`}
      onClick={onRemove}
      className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <X className="size-3" aria-hidden />
    </button>
  );
  if (a.preview.src)
    return (
      <span className="relative flex">
        <img src={a.preview.src} alt={a.preview.name} className="size-12 rounded-md border object-cover" />
        <span className="absolute -top-1.5 -right-1.5 rounded-md bg-card">{remove}</span>
      </span>
    );
  const Icon = a.preview.kind === "image" ? ImageIcon : FileText;
  return (
    <span title={a.wire.kind === "file" ? a.wire.path : a.preview.name} className="flex h-7 max-w-48 items-center gap-1.5 rounded-md bg-muted pr-0.5 pl-2 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">{a.preview.name}</span>
      {remove}
    </span>
  );
}

const MENU_ITEM = "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-[highlighted]:bg-accent";

/** 入力欄の左の + : 添えるもののメニュー（ほかのメニューと同じ分離アニメーションで開く） */
function AddMenu({ att }: { att: AttachmentsState }) {
  const anchor = `add:${useId()}`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  const raised = useLiquidActiveAnchors().has(anchor);
  return (
    <DropdownMenu.Root onOpenChange={menu.onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={liquidAnchor(anchor)}
          type="button"
          aria-label="添える"
          className={cn(
            "relative flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
            raised && "z-[57]",
          )}
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={menu.ref as React.Ref<HTMLDivElement>}
          style={menu.style}
          side="top"
          align="start"
          sideOffset={6}
          className={cn("z-[58] flex min-w-56 flex-col gap-0.5 rounded-[10px] border bg-popover p-1 text-popover-foreground", menu.moving && "opacity-0")}
        >
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void att.pick("file")}>
            <Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
            ファイルを添える
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void att.pick("image")}>
            <ImageIcon className="size-3.5 text-muted-foreground" aria-hidden />
            画像を添える
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-0.5 h-px bg-border" />
          <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
            <Keys keys={["cmd", "v"]} />
            で画像を貼り付け。ペインに落としても添えられます
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** 入力欄の枠。添えたものを上に並べ、ファイルを持ってくると枠を明るくする */
export function AttachBox({ att, children }: { att: AttachmentsState; children: React.ReactNode }) {
  return (
    <div
      ref={att.boxRef}
      onPaste={att.onPaste}
      className={cn("flex flex-col rounded-xl border border-input bg-card transition-colors focus-within:border-ring", att.over && "border-ring bg-accent")}
    >
      <AnimatePresence initial={false}>
        {att.items.length > 0 && (
          <motion.div key="chips" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={smooth} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 px-2 pt-2.5">
              <AnimatePresence initial={false}>
                {att.items.map((a) => (
                  <motion.span key={a.key} layout="position" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={bouncy} className="flex">
                    <Chip a={a} onRemove={() => att.remove(a.key)} />
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-end gap-1.5 py-1.5 pr-1.5 pl-1.5">
        <AddMenu att={att} />
        {children}
      </div>
    </div>
  );
}

/** 会話の中の自分の発言に添えたもの */
export function SentAttachments({ items }: { items: { kind: "image" | "file"; name: string; src?: string }[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {items.map((a, i) =>
        a.src ? (
          <img key={i} src={a.src} alt={a.name} className="max-h-40 max-w-60 rounded-[10px] border object-contain" />
        ) : (
          <span key={i} className="flex h-7 max-w-60 items-center gap-1.5 rounded-md bg-muted px-2 text-xs">
            {a.kind === "image" ? <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="min-w-0 truncate">{a.name}</span>
          </span>
        ),
      )}
    </div>
  );
}
