import { Pencil, Square, Trash2 } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { useState } from "react";

import { useT } from "@/i18n";
import type { SessionRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { Keys } from "./Keys";
import { useLiquidMenu } from "./liquid/stage";

export const MENU_ITEM =
  "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent";

/** Single-letter shortcut shown at the right of a menu item */
export const Shortcut = ({ k }: { k: string }) => <Keys keys={[k]} className="ml-auto pl-4 opacity-70" />;

/**
 * Keys that pick menu items while the menu is open: R rename, S stop, D delete; in the delete options W also removes the
 * worktree, D deletes the record only (pressing D twice keeps the worktree) and esc goes back. A key clicks the item
 * marked with data-key, so it behaves exactly like choosing it with the pointer
 */
export function pickByKey(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
  const item = e.currentTarget.querySelector<HTMLElement>(`[data-key="${e.key.toLowerCase()}"]:not([data-disabled])`);
  if (!item) return;
  // Stop Radix's type-ahead from also moving the highlight
  e.preventDefault();
  item.click();
}

/** Context menu for sidebar rows: rename, stop, delete (with a choice to keep the worktree) */
export function SessionMenu({ record, onRename, children }: { record: SessionRecord; onRename: () => void; children: React.ReactNode }) {
  const t = useT();
  const { stopSession, removeSession } = useStore.getState();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = record.status !== "closed" && record.status !== "error";
  const run = (f: () => Promise<void>) => void f().catch((e) => setError(String(e)));
  // The menu expands out of the right-clicked row and shrinks back into it on close
  const menu = useLiquidMenu(`menu:session:${record.id}`, `session:${record.id}`);

  return (
    <ContextMenu.Root
      onOpenChange={(o) => {
        menu.onOpenChange(o);
        if (!o) {
          setConfirm(false);
          setError(null);
        }
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          ref={menu.ref as React.Ref<HTMLDivElement>}
          style={menu.style}
          className={cn(
            "z-[80] flex min-w-52 flex-col gap-0.5 rounded-[10px] border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,.45)]",
            menu.moving && "opacity-0",
          )}
          onKeyDown={(e) => {
            // esc in the delete options goes back to the first menu instead of closing it
            if (confirm && e.key === "Escape") {
              e.preventDefault();
              setConfirm(false);
              return;
            }
            pickByKey(e);
          }}
        >
          {!confirm ? (
            <>
              <ContextMenu.Item data-key="r" className={MENU_ITEM} onSelect={onRename}>
                <Pencil className="size-3.5 text-muted-foreground" aria-hidden />
                {t("sessionMenu.rename")}
                <Shortcut k="r" />
              </ContextMenu.Item>
              <ContextMenu.Item data-key="s" className={MENU_ITEM} disabled={!running} onSelect={() => run(() => stopSession(record.id))}>
                <Square className="size-3.5 text-muted-foreground" aria-hidden />
                {t("sessionMenu.stop")}
                <Shortcut k="s" />
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-0.5 h-px bg-border" />
              <ContextMenu.Item
                data-key="d"
                className={cn(MENU_ITEM, "text-error data-[highlighted]:bg-error/10")}
                onSelect={(e) => {
                  // Go to the delete options without closing the menu
                  e.preventDefault();
                  setConfirm(true);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t("sessionMenu.delete")}
                <Shortcut k="d" />
              </ContextMenu.Item>
            </>
          ) : (
            <>
              <ContextMenu.Label className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
                {t("sessionMenu.confirmDelete", { title: record.title })}
              </ContextMenu.Label>
              {record.worktree_path && (
                <ContextMenu.Item
                  data-key="w"
                  className={cn(MENU_ITEM, "text-error data-[highlighted]:bg-error/10")}
                  onSelect={() => run(() => removeSession(record.id, true))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  {t("sessionMenu.deleteWithWorktree")}
                  <Shortcut k="w" />
                </ContextMenu.Item>
              )}
              <ContextMenu.Item
                data-key="d"
                className={cn(MENU_ITEM, "text-error data-[highlighted]:bg-error/10")}
                onSelect={() => run(() => removeSession(record.id, false))}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {record.worktree_path ? t("sessionMenu.deleteRecordOnly") : t("sessionMenu.deleteRecord")}
                <Shortcut k="d" />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={MENU_ITEM}
                onSelect={(e) => {
                  e.preventDefault();
                  setConfirm(false);
                }}
              >
                {t("sessionMenu.cancel")}
                <Shortcut k="esc" />
              </ContextMenu.Item>
            </>
          )}
          {error && <p className="max-w-64 px-2 py-1 text-xs whitespace-pre-wrap text-error">{error}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
