import { Pencil, Square, Trash2 } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { useState } from "react";

import type { SessionRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { useLiquidMenu } from "./liquid/stage";

const ITEM =
  "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent";

/** サイドバーの行の右クリックメニュー: 名前を変える・止める・削除（worktree を残すか選ぶ） */
export function SessionMenu({ record, onRename, children }: { record: SessionRecord; onRename: () => void; children: React.ReactNode }) {
  const { stopSession, removeSession } = useStore.getState();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = record.status !== "closed" && record.status !== "error";
  const run = (f: () => Promise<void>) => void f().catch((e) => setError(String(e)));
  // メニューは、右クリックした行から飛び出して広がり、閉じると行へ戻る
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
          className={cn("z-[80] flex min-w-52 flex-col gap-0.5 rounded-[10px] border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,.45)]", menu.moving && "opacity-0")}
        >
          {!confirm ? (
            <>
              <ContextMenu.Item className={ITEM} onSelect={onRename}>
                <Pencil className="size-3.5 text-muted-foreground" aria-hidden />
                名前を変える
              </ContextMenu.Item>
              <ContextMenu.Item className={ITEM} disabled={!running} onSelect={() => run(() => stopSession(record.id))}>
                <Square className="size-3.5 text-muted-foreground" aria-hidden />
                止める
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-0.5 h-px bg-border" />
              <ContextMenu.Item
                className={cn(ITEM, "text-error data-[highlighted]:bg-error/10")}
                onSelect={(e) => {
                  // メニューを閉じずに、消し方の選択へ
                  e.preventDefault();
                  setConfirm(true);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
                削除…
              </ContextMenu.Item>
            </>
          ) : (
            <>
              <ContextMenu.Label className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">「{record.title}」を消します</ContextMenu.Label>
              {record.worktree_path && (
                <ContextMenu.Item className={cn(ITEM, "text-error data-[highlighted]:bg-error/10")} onSelect={() => run(() => removeSession(record.id, true))}>
                  <Trash2 className="size-3.5" aria-hidden />
                  worktree と枝も消す
                </ContextMenu.Item>
              )}
              <ContextMenu.Item className={cn(ITEM, "text-error data-[highlighted]:bg-error/10")} onSelect={() => run(() => removeSession(record.id, false))}>
                <Trash2 className="size-3.5" aria-hidden />
                {record.worktree_path ? "記録だけ消す（worktree は残す）" : "記録を消す"}
              </ContextMenu.Item>
              <ContextMenu.Item
                className={ITEM}
                onSelect={(e) => {
                  e.preventDefault();
                  setConfirm(false);
                }}
              >
                やめる
              </ContextMenu.Item>
            </>
          )}
          {error && <p className="max-w-64 px-2 py-1 text-xs whitespace-pre-wrap text-error">{error}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
