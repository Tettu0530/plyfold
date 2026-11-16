// macOS の通知。アプリを見ていないあいだに、手を貸す必要があるとき・ターンが終わったときだけ出す
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

import { inTauri } from "./api";

let allowed: boolean | null = null;

async function ensure(): Promise<boolean> {
  if (!inTauri) return false;
  if (allowed !== null) return allowed;
  try {
    allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    allowed = false;
  }
  return allowed;
}

export function notify(title: string, body: string) {
  if (document.hasFocus()) return;
  void ensure().then((ok) => {
    if (ok) sendNotification({ title, body });
  });
}
