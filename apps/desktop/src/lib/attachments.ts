// Prompt attachments (images, files): the wire format (same as the engine's Attachment) and the preview shown in the UI

/** Shape sent to the engine (Attachment in crates/plyfold-core/src/attach.rs) */
export type AttachmentWire = { kind: "image"; data: string; mime: string; name: string | null } | { kind: "file"; path: string };

/** Preview shown in the UI. Images are shown as thumbnails via src (a data: URL) */
export interface AttachmentPreview {
  kind: "image" | "file";
  name: string;
  src?: string;
  /** Path of a dropped file (used when resending) */
  path?: string;
}

export interface Attached {
  /** Key for rendering lists */
  key: string;
  wire: AttachmentWire;
  preview: AttachmentPreview;
}

let seq = 0;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
export const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** Read a pasted image (a file from the clipboard) */
export function readImage(file: File): Promise<Attached> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const url = String(r.result);
      const data = url.slice(url.indexOf(",") + 1);
      const name = file.name || "image.png";
      resolve({ key: `a${++seq}`, wire: { kind: "image", data, mime: file.type || "image/png", name }, preview: { kind: "image", name, src: url } });
    };
    r.readAsDataURL(file);
  });
}

/** A dropped file. Image files show only their name, since previews can't be loaded from Tauri assets */
export function fromPath(path: string): Attached {
  return { key: `a${++seq}`, wire: { kind: "file", path }, preview: { kind: IMAGE_EXT.test(path) ? "image" : "file", name: baseName(path), path } };
}

/** Rebuild previews from sent session/prompt blocks (when rebuilding a conversation from the log) */
export function previewsOfPrompt(blocks: unknown[]): AttachmentPreview[] {
  const out: AttachmentPreview[] = [];
  for (const b of blocks) {
    const o = b as { type?: string; data?: string; mimeType?: string; uri?: string; name?: string };
    const path = o.uri?.startsWith("file://") ? decodeURIComponent(o.uri.slice("file://".length)) : undefined;
    if (o?.type === "image" && typeof o.data === "string") {
      out.push({ kind: "image", name: path ? baseName(path) : "image", src: `data:${o.mimeType ?? "image/png"};base64,${o.data}` });
    } else if (o?.type === "resource_link" && typeof o.name === "string") {
      out.push({ kind: IMAGE_EXT.test(o.name) ? "image" : "file", name: o.name, ...(path ? { path } : {}) });
    }
  }
  return out;
}

/** Turn previews of a sent message back into resendable attachments (images from the data: URL, files from the path; dropped if neither exists) */
export function resendable(previews: AttachmentPreview[]): Attached[] {
  const out: Attached[] = [];
  for (const p of previews) {
    if (p.src?.startsWith("data:")) {
      const comma = p.src.indexOf(",");
      const mime = p.src.slice(5, p.src.indexOf(";"));
      out.push({ key: `a${++seq}`, wire: { kind: "image", data: p.src.slice(comma + 1), mime, name: p.name }, preview: p });
    } else if (p.path) {
      out.push({ key: `a${++seq}`, wire: { kind: "file", path: p.path }, preview: p });
    }
  }
  return out;
}
