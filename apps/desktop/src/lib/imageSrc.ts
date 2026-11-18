/**
 * Where an image in an agent's answer comes from: a data URL to show as is, a file on this machine to read, or
 * nothing (an image on the web is not fetched: the server would learn the answer was opened)
 */
export type ImageSource = { kind: "data"; src: string } | { kind: "file"; path: string } | null;

export function imageSource(src: string | undefined, base: string | undefined): ImageSource {
  if (!src) return null;
  if (/^data:image\//i.test(src)) return { kind: "data", src };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) && !/^file:/i.test(src)) return null;
  let path: string;
  try {
    path = /^file:/i.test(src) ? decodeURIComponent(new URL(src).pathname) : decodeURIComponent(src);
  } catch {
    path = src;
  }
  // file:///C:/x → /C:/x
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) return { kind: "file", path };
  if (!base) return null;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return { kind: "file", path: base.replace(/[\\/]+$/, "") + sep + path.replace(/^\.[\\/]/, "") };
}
