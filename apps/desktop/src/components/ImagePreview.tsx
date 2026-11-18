// Image preview: clicking an attached or sent image opens it large, growing out of the thumbnail with the same
// separation motion as other surfaces (the image is clipped to the liquid body while it grows). Click anywhere or
// press esc to close; it shrinks back into the thumbnail.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
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

const usePreview = create<{ current: Preview | null; closing: boolean }>(() => ({ current: null, closing: false }));
const ID = "image-preview";
// The body fades to nothing as it expands: the image itself becomes the surface, so a spring overshoot never shows a
// grey frame around it
const CLEAR = { background: "rgba(23, 23, 23, 0)", border: "rgba(255, 255, 255, 0)", shadow: "0px 0px 0px rgba(0, 0, 0, 0)", blur: 0 };
const target = () => document.querySelector<HTMLElement>("[data-image-preview]");

export function openImagePreview(p: Preview) {
  usePreview.setState({ current: p, closing: false });
  liquidOpen(ID, { anchor: p.anchor, target, radius: 10, anchorRadius: 6, toLook: CLEAR });
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
  const { current, closing } = usePreview();
  const ref = useRef<HTMLImageElement>(null);
  // While it grows or shrinks, only the part inside the liquid body shows (hidden until the clip takes over)
  const moving = useLiquidClip(ID, ref);
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeImagePreview();
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
            <img
              ref={ref}
              data-image-preview
              src={current.src}
              alt={current.name}
              title={t("attach.closePreview")}
              className={cn("max-h-full max-w-full cursor-zoom-out rounded-[10px] object-contain", moving && "opacity-0")}
            />
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
