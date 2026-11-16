// プロンプトに添えるもの（画像、ファイル）。送るときの形（エンジンの Attachment と同じ）と、画面に出す見本を持つ

/** エンジンへ送る形（crates/plyfold-core/src/attach.rs の Attachment） */
export type AttachmentWire = { kind: "image"; data: string; mime: string; name: string | null } | { kind: "file"; path: string };

/** 画面に出す見本。画像は src（data: の URL）で縮小して見せる */
export interface AttachmentPreview {
  kind: "image" | "file";
  name: string;
  src?: string;
}

export interface Attached {
  /** 並べるときのキー */
  key: string;
  wire: AttachmentWire;
  preview: AttachmentPreview;
}

let seq = 0;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
export const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** 貼り付けた画像（クリップボードのファイル）を読む */
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

/** 落としたファイル。画像のファイルは、見本の画像を Tauri の asset から読めないので名前だけ出す */
export function fromPath(path: string): Attached {
  return { key: `a${++seq}`, wire: { kind: "file", path }, preview: { kind: IMAGE_EXT.test(path) ? "image" : "file", name: baseName(path) } };
}

/** 送った session/prompt の塊から、見本を作り直す（記録から会話を組み立てるとき） */
export function previewsOfPrompt(blocks: unknown[]): AttachmentPreview[] {
  const out: AttachmentPreview[] = [];
  for (const b of blocks) {
    const o = b as { type?: string; data?: string; mimeType?: string; uri?: string; name?: string };
    if (o?.type === "image" && typeof o.data === "string") {
      out.push({ kind: "image", name: o.uri ? baseName(decodeURIComponent(o.uri)) : "image", src: `data:${o.mimeType ?? "image/png"};base64,${o.data}` });
    } else if (o?.type === "resource_link" && typeof o.name === "string") {
      out.push({ kind: IMAGE_EXT.test(o.name) ? "image" : "file", name: o.name });
    }
  }
  return out;
}
