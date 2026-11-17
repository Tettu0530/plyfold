import { Equal, PanelBottom, PanelRight, X } from "lucide-react";
import { ContextMenu } from "radix-ui";

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidMenu } from "../liquid/stage";
import { MENU_ITEM, pickByKey, Shortcut } from "../SessionMenu";

/** Liquid anchor name for a pane's header (the menu grows out of it) */
export const paneHeadAnchor = (slot: number) => liquidAnchor(`pane-head:${slot}`);

/**
 * Context menu for a pane's header (or an empty pane): split right or down (R / D), even out the layout (E), close the
 * pane (W). The child must take the ref from paneHeadAnchor(slot)
 */
export function PaneMenu({ slot, children }: { slot: number; children: React.ReactNode }) {
  const t = useT();
  const menu = useLiquidMenu(`menu:pane-head:${slot}`, `pane-head:${slot}`);
  const removable = useStore((s) => s.paneCount > 1);
  const split = (edge: "right" | "bottom") => {
    const s = useStore.getState();
    s.focusPane(s.splitPane(slot, edge, null));
  };
  return (
    <ContextMenu.Root onOpenChange={menu.onOpenChange}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          ref={menu.ref as React.Ref<HTMLDivElement>}
          style={menu.style}
          onKeyDown={pickByKey}
          className={cn("z-[80] flex min-w-52 flex-col gap-0.5 rounded-[10px] border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,.45)]", menu.moving && "opacity-0")}
        >
          <ContextMenu.Item data-key="r" className={MENU_ITEM} onSelect={() => split("right")}>
            <PanelRight className="size-3.5 text-muted-foreground" aria-hidden />
            {t("pane.splitRight")}
            <Shortcut k="r" />
          </ContextMenu.Item>
          <ContextMenu.Item data-key="d" className={MENU_ITEM} onSelect={() => split("bottom")}>
            <PanelBottom className="size-3.5 text-muted-foreground" aria-hidden />
            {t("pane.splitDown")}
            <Shortcut k="d" />
          </ContextMenu.Item>
          <ContextMenu.Item data-key="e" className={MENU_ITEM} disabled={!removable} onSelect={() => useStore.getState().evenLayout()}>
            <Equal className="size-3.5 text-muted-foreground" aria-hidden />
            {t("pane.evenLayout")}
            <Shortcut k="e" />
          </ContextMenu.Item>
          <ContextMenu.Separator className="mx-1 my-0.5 h-px bg-border" />
          <ContextMenu.Item data-key="w" className={MENU_ITEM} disabled={!removable} onSelect={() => useStore.getState().removePane(slot)}>
            <X className="size-3.5 text-muted-foreground" aria-hidden />
            {t("pane.removePane")}
            <Shortcut k="w" />
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
