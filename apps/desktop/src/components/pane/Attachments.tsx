// Attachments for the input: paste images (⌘V), drop files onto the pane. Shown before sending; × removes one
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, ImageIcon, Paperclip, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";

import { inTauri } from "@/lib/api";
import { fromPath, readImage, type Attached, type AttachmentPreview } from "@/lib/attachments";
import { addDropTarget } from "@/lib/drop";
import { hasMention } from "./Mention";
import { openImagePreview, useImageSrc } from "../ImagePreview";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { bouncy, smooth } from "../motion";
import { Keys } from "../Keys";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";
import { useT } from "@/i18n";
import { actionFor } from "@/lib/keymap";
import { currentBindings, useKeys } from "@/state/keys";

/**
 * onMentionRemoved: called with the path when a chip that came from an @-mention is removed, so the caller can
 * delete "@path" from the text too
 */
export function useAttachments({ onMentionRemoved, scope }: { onMentionRemoved?: (path: string) => void; scope?: string } = {}) {
  const t = useT();
  const [items, setItems] = useState<Attached[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [over, setOver] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      addDropTarget({
        // Dropping anywhere on the pane attaches to that pane's input
        el: () => boxRef.current?.closest<HTMLElement>("[data-pane-index]") ?? boxRef.current,
        onOver: setOver,
        onDrop: (paths) => setItems((a) => [...a, ...paths.map(fromPath)]),
      }),
    [],
  );
  const onPaste = (e: React.ClipboardEvent) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    // If there is text as well, paste the text normally
    if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
    void Promise.all(images.map(readImage)).then((read) => setItems((a) => [...a, ...read]));
  };
  /** Open the macOS file picker (files and images alike) and attach. Passed as paths, so handled the same as a drop */
  const pick = async () => {
    if (!inTauri) return;
    const picked = await openDialog({ multiple: true, directory: false, title: t("attach.pickTitle") });
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length) setItems((a) => [...a, ...paths.map(fromPath)]);
  };
  // ⌘U opens the file picker for the focused pane's composer (scope is the pane's session or draft id)
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    if (!scope) return;
    const onKey = (e: KeyboardEvent) => {
      if (actionFor(e, currentBindings()) !== "attach") return;
      const s = useStore.getState();
      if (s.panes[s.focusedPane] !== scope) return;
      e.preventDefault();
      void pickRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope]);
  return {
    items,
    over,
    boxRef,
    onPaste,
    pick,
    remove: (key: string) => {
      const gone = itemsRef.current.find((x) => x.key === key);
      setItems((a) => a.filter((x) => x.key !== key));
      if (gone?.mention) onMentionRemoved?.(gone.mention);
    },
    /** Attach a file mentioned as "@mention" in the text, unless it is already attached */
    addMention: (path: string, mention: string) =>
      setItems((a) => (a.some((x) => x.wire.kind === "file" && x.wire.path === path) ? a : [...a, { ...fromPath(path), mention }])),
    /** Drop @-mention chips whose "@path" is no longer in the text (chips added other ways stay) */
    syncMentions: (text: string) =>
      setItems((a) => {
        const kept = a.filter((x) => !x.mention || hasMention(text, x.mention));
        return kept.length === a.length ? a : kept;
      }),
    clear: () => setItems([]),
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

/** A clickable image thumbnail that opens the large preview (growing out of the thumbnail) */
function Thumb({ src, name, anchor, className }: { src: string; name: string; anchor: string; className?: string }) {
  const t = useT();
  return (
    <button
      ref={liquidAnchor(anchor)}
      type="button"
      aria-label={t("attach.preview", { name })}
      title={name}
      onClick={() => openImagePreview({ src, name, anchor })}
      className="flex cursor-zoom-in rounded-md focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img src={src} alt={name} className={cn("rounded-md border", className)} />
    </button>
  );
}

function Chip({ a, onRemove }: { a: Attached; onRemove: () => void }) {
  const t = useT();
  // Images attached by path get their thumbnail read from the file
  const src = useImageSrc(a.preview);
  const remove = (
    <button
      type="button"
      aria-label={t("attach.removeItem", { name: a.preview.name })}
      onClick={onRemove}
      className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <X className="size-3" aria-hidden />
    </button>
  );
  if (src)
    return (
      <span className="relative flex">
        <Thumb src={src} name={a.preview.name} anchor={`img:${a.key}`} className="size-12 object-cover" />
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

/** The + left of the input: attachment menu (opens with the same separation animation as other menus) */
function AddMenu({ att }: { att: AttachmentsState }) {
  const t = useT();
  const attachKeys = useKeys("attach");
  // Where the keys sit in the sentence depends on the language, so split around {keys} and put Keys in between
  const [hintBefore, hintAfter = ""] = t("attach.pasteHint").split("{keys}").map((s) => s.trim());
  const anchor = `add:${useId()}`;
  const menu = useLiquidMenu(`menu:${anchor}`, anchor);
  const raised = useLiquidActiveAnchors().has(anchor);
  return (
    <DropdownMenu.Root onOpenChange={menu.onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={liquidAnchor(anchor)}
          type="button"
          aria-label={t("attach.add")}
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
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void att.pick()}>
            <Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
            {t("attach.attachFiles")}
            <Keys keys={attachKeys} className="ml-auto pl-4 opacity-70" />
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-0.5 h-px bg-border" />
          <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
            {hintBefore}
            <Keys keys={["cmd", "v"]} />
            {hintAfter}
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The input's frame. Lists attachments above it and highlights when a file is dragged over */
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

/** Attachments on the user's own message in the transcript */
export function SentAttachments({ items }: { items: AttachmentPreview[] }) {
  // Each list gets its own anchor prefix so thumbnails in different messages don't share an animation origin
  const prefix = useId();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {items.map((a, i) => (
        <SentItem key={i} a={a} anchor={`img:${prefix}:${i}`} />
      ))}
    </div>
  );
}

function SentItem({ a, anchor }: { a: AttachmentPreview; anchor: string }) {
  const src = useImageSrc(a);
  if (src) return <Thumb src={src} name={a.name} anchor={anchor} className="max-h-40 max-w-60 rounded-[10px] object-contain" />;
  return (
    <span className="flex h-7 max-w-60 items-center gap-1.5 rounded-md bg-muted px-2 text-xs">
      {a.kind === "image" ? <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 truncate">{a.name}</span>
    </span>
  );
}
