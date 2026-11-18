// Image preview: clicking an attached or sent image opens it large, growing out of the thumbnail with the same
// separation motion as other surfaces (the image is clipped to the liquid body while it grows). Click anywhere or
// press esc to close; it shrinks back into the thumbnail.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import type { AttachmentPreview } from "@/lib/attachments";
import { cn } from "@/lib/utils";
import { smooth } from "./motion";
import { liquidCloseFrom, liquidOpen, useLiquidClip } from "./liquid/stage";

interface Preview {
  src: string;
  name: string;
  /** liquidAnchor name of the thumbnail it opened from */
  anchor: string;
}

/** The open image, the images it can step through (its group, in page order) and the last step's direction */
const usePreview = create<{ current: Preview | null; items: Preview[]; index: number; dir: number; closing: boolean }>(() => ({
  current: null,
  items: [],
  index: 0,
  dir: 0,
  closing: false,
}));
const ID = "image-preview";
// The body fades to nothing as it expands: the image itself becomes the surface, so a spring overshoot never shows a
// grey frame around it
const CLEAR = { background: "rgba(23, 23, 23, 0)", border: "rgba(255, 255, 255, 0)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
// The shown image (while stepping, the one leaving is still in the page for a moment)
const target = () => document.querySelector<HTMLElement>(`[data-image-preview="${usePreview.getState().index}"]`);

/** Whether the large preview is open (it takes ← and → for itself) */
export const isImagePreviewOpen = () => usePreview.getState().current !== null;

/** Open p large. With items (p among them), ← and → step through them */
export function openImagePreview(p: Preview, items: Preview[] = [p]) {
  const index = Math.max(
    0,
    items.findIndex((i) => i.anchor === p.anchor),
  );
  usePreview.setState({ current: items[index] ?? p, items: items.length ? items : [p], index, dir: 0, closing: false });
  liquidOpen(ID, { anchor: p.anchor, target, radius: 10, anchorRadius: 6, toLook: CLEAR });
}

/** Move to the previous or next image of the group (stops at the ends). Closing then shrinks into that one's thumbnail */
function stepImagePreview(d: number) {
  const { items, index, closing } = usePreview.getState();
  const next = index + d;
  if (closing || next < 0 || next >= items.length) return;
  usePreview.setState({ current: items[next], index: next, dir: d });
}

// ---- groups: thumbnails in one answer or one message step through each other in the preview

interface Member {
  preview: () => Preview;
  el: () => HTMLElement | null;
}
const Group = createContext<Map<string, Member> | null>(null);

/** Thumbnails inside open as one set in the preview */
export function PreviewGroup({ children }: { children: React.ReactNode }) {
  const [members] = useState(() => new Map<string, Member>());
  return <Group.Provider value={members}>{children}</Group.Provider>;
}

/** For a thumbnail: join the surrounding group, and get the images to open with (its group in page order, or itself) */
export function usePreviewGroup(anchor: string, preview: Preview, el: () => HTMLElement | null): () => Preview[] {
  const members = useContext(Group);
  const latest = useRef(preview);
  latest.current = preview;
  useEffect(() => {
    if (!members) return;
    members.set(anchor, { preview: () => latest.current, el });
    return () => {
      members.delete(anchor);
    };
  }, [members, anchor, el]);
  return () => {
    if (!members) return [latest.current];
    return [...members.values()]
      .filter((m) => m.el())
      .sort((a, b) => (a.el()!.compareDocumentPosition(b.el()!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((m) => m.preview());
  };
}

function closeImagePreview() {
  const { current, closing } = usePreview.getState();
  if (!current || closing) return;
  usePreview.setState({ closing: true });
  liquidCloseFrom(ID, {
    anchor: current.anchor,
    target,
    radius: 10,
    anchorRadius: 6,
    toLook: CLEAR,
    onDone: () => usePreview.setState({ current: null, closing: false }),
  });
}

// ---- thumbnails of images that were attached by path (dropped or picked): loaded once per path

const loaded = new Map<string, Promise<string | null>>();
function loadImage(path: string): Promise<string | null> {
  let p = loaded.get(path);
  if (!p) {
    p = inTauri ? api.readImage(path).catch(() => null) : Promise.resolve(null);
    loaded.set(path, p);
  }
  return p;
}

/** An image file's data URL: undefined while loading, null when it cannot be read (or outside the app) */
export function useFileImage(path: string | null): string | null | undefined {
  const [src, setSrc] = useState<{ path: string; src: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    void loadImage(path).then((s) => alive && setSrc({ path, src: s }));
    return () => {
      alive = false;
    };
  }, [path]);
  if (!path) return null;
  return src?.path === path ? src.src : undefined;
}

/** The image's data URL: the one it already has, or read from its path. null while loading or for non-images */
export function useImageSrc(preview: AttachmentPreview): string | null {
  const [src, setSrc] = useState<string | null>(preview.src ?? null);
  useEffect(() => {
    if (preview.src || preview.kind !== "image" || !preview.path) return;
    let alive = true;
    void loadImage(preview.path).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [preview.src, preview.kind, preview.path]);
  return preview.src ?? src;
}

/** Mounted once in the app */
export function ImagePreview() {
  const t = useT();
  const { current, items, index, dir, closing } = usePreview();
  const ref = useRef<HTMLImageElement>(null);
  const many = items.length > 1;
  // While it grows or shrinks, only the part inside the liquid body shows (hidden until the clip takes over)
  const moving = useLiquidClip(ID, ref);
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeImagePreview();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        stepImagePreview(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);
  return (
    <AnimatePresence>
      {current && (
        <>
          {/* The dimmed backdrop sits below the liquid body (z 55); the image sits above it */}
          <motion.div
            key="backdrop"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: closing ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={smooth}
            onClick={closeImagePreview}
            className="fixed inset-0 z-[54] bg-black/60"
          />
          <div
            key="image"
            role="dialog"
            aria-label={current.name}
            className="fixed inset-0 z-[58] flex items-center justify-center p-10"
            onClick={closeImagePreview}
          >
            {/* Stepping slides the next image in from the side it comes from */}
            <AnimatePresence initial={false} mode="popLayout" custom={dir}>
              <motion.img
                key={index}
                ref={(el) => {
                  if (el) ref.current = el;
                }}
                data-image-preview={index}
                src={current.src}
                alt={current.name}
                title={t("attach.closePreview")}
                custom={dir}
                variants={{
                  enter: (d: number) => ({ opacity: 0, x: d * 32 }),
                  center: { opacity: 1, x: 0 },
                  leave: (d: number) => ({ opacity: 0, x: d * -32 }),
                }}
                initial="enter"
                animate="center"
                exit="leave"
                transition={smooth}
                className={cn("max-h-full max-w-full cursor-zoom-out rounded-[10px] object-contain", moving && "opacity-0")}
              />
            </AnimatePresence>
          </div>
          {many && !moving && !closing && (
            <motion.div
              key="steps"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={smooth}
              className="pointer-events-none fixed inset-0 z-[59] flex items-center justify-between px-3"
            >
              <StepButton label={t("attach.previousImage")} disabled={index === 0} onClick={() => stepImagePreview(-1)}>
                <ChevronLeft className="size-5" aria-hidden />
              </StepButton>
              <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/60 px-2 py-0.5 font-mono text-xs text-muted-foreground tabular">
                {index + 1} / {items.length}
              </span>
              <StepButton label={t("attach.nextImage")} disabled={index === items.length - 1} onClick={() => stepImagePreview(1)}>
                <ChevronRight className="size-5" aria-hidden />
              </StepButton>
            </motion.div>
          )}
        </>
      )}
    </AnimatePresence>
  );
}

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="pointer-events-auto flex size-9 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-[0_4px_12px_rgba(0,0,0,.45)] hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
    >
      {children}
    </button>
  );
}
