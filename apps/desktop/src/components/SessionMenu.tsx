import { GitFork, Pencil, Square, Trash2 } from "lucide-react";
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
 * Keys that pick menu items while the menu is open: R rename, S stop, F fork, D delete. In the fork options N uses a new
 * worktree and W keeps this workspace. In the delete options W also removes the worktree, D deletes the record only
 * (pressing D twice keeps the worktree) and esc goes back. A key clicks the item marked with data-key, so it behaves
 * exactly like choosing it with the pointer
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
  const { stopSession, trashSession, forkSession } = useStore.getState();
  const [view, setView] = useState<"main" | "fork">("main");
  const [error, setError] = useState<string | null>(null);
  const running = record.status !== "closed" && record.status !== "error";
  const inTurn = record.status === "starting" || record.status === "working" || record.status === "awaiting_permission" || record.status === "stalled";
  const run = (f: () => Promise<void>) => void f().catch((e) => setError(String(e)));
  const forkHint = !record.acp_session_id ? t("sessionMenu.forkNeedsConversation") : inTurn ? t("sessionMenu.forkBusy") : undefined;
  // The menu expands out of the right-clicked row and shrinks back into it on close
  const menu = useLiquidMenu(`menu:session:${record.id}`, `session:${record.id}`);

  return (
    <ContextMenu.Root
      onOpenChange={(o) => {
        menu.onOpenChange(o);
        if (!o) {
          setView("main");
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
            if (view !== "main" && e.key === "Escape") {
              e.preventDefault();
              setView("main");
              return;
            }
            pickByKey(e);
          }}
        >
          {view === "main" ? (
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
              <ContextMenu.Item
                data-key="f"
                className={MENU_ITEM}
                onSelect={(e) => {
                  e.preventDefault();
                  setView("fork");
                }}
              >
                <GitFork className="size-3.5 text-muted-foreground" aria-hidden />
                {t("sessionMenu.fork")}
                <Shortcut k="f" />
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-0.5 h-px bg-border" />
              <ContextMenu.Item
                data-key="d"
                className={cn(MENU_ITEM, "text-error data-[highlighted]:bg-error/10")}
                onSelect={() => run(() => trashSession(record.id))}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t("sessionMenu.delete")}
                <Shortcut k="d" />
              </ContextMenu.Item>
            </>
          ) : view === "fork" ? (
            <>
              <ContextMenu.Label className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
                {forkHint ?? t("sessionMenu.forkTitle", { title: record.title })}
              </ContextMenu.Label>
              <ContextMenu.Item
                data-key="n"
                className={MENU_ITEM}
                disabled={forkHint !== undefined || !record.repo_path}
                onSelect={() => run(() => forkSession(record.id, true))}
              >
                <GitFork className="size-3.5 text-muted-foreground" aria-hidden />
                {t("sessionMenu.forkNew")}
                <Shortcut k="n" />
              </ContextMenu.Item>
              <ContextMenu.Item
                data-key="w"
                className={MENU_ITEM}
                disabled={forkHint !== undefined || running}
                title={forkHint === undefined && running ? t("sessionMenu.forkStopFirst") : undefined}
                onSelect={() => run(() => forkSession(record.id, false))}
              >
                <GitFork className="size-3.5 text-muted-foreground" aria-hidden />
                {t("sessionMenu.forkSame")}
                <Shortcut k="w" />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={MENU_ITEM}
                onSelect={(e) => {
                  e.preventDefault();
                  setView("main");
                }}
              >
                {t("sessionMenu.cancel")}
                <Shortcut k="esc" />
              </ContextMenu.Item>
            </>
          ) : null}
          {error && <p className="max-w-64 px-2 py-1 text-xs whitespace-pre-wrap text-error">{error}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
