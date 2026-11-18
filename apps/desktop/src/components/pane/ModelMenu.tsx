// Model and effort in one chip and one menu: the models, then "Effort ›" opening the effort levels to the side.
// Agents with only one of the two get just that list. Both menus open with the same liquid motion as other menus
import { Check, ChevronRight, ChevronsUpDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef } from "react";

import { useT } from "@/i18n";
import type { ConfigOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "../icons";
import { liquidAnchor } from "../liquid/liquid";
import { useLiquidActiveAnchors, useLiquidMenu } from "../liquid/stage";
import { CHIP_TRIGGER } from "./chip";

const CONTENT = "z-[58] min-w-[11rem] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md";
const ITEM =
  "relative flex h-8 w-full cursor-default items-center gap-2 rounded-sm pr-8 pl-2 text-sm outline-hidden select-none data-[highlighted]:bg-accent data-[state=open]:bg-accent";

/** The effort level as rising bars, filled up to the current one */
function EffortBars({ effort }: { effort: ConfigOption }) {
  const at = effort.choices.findIndex((x) => x.value === effort.current);
  return (
    <span className="flex h-2.5 items-end gap-0.5" aria-hidden>
      {effort.choices.map((c, i) => (
        <span key={c.value} className={cn("block w-[3px] rounded-[1px]", i <= at ? "bg-foreground" : "bg-input")} style={{ height: 2 + i * 2 }} />
      ))}
    </span>
  );
}

function Choices({ option, onPick }: { option: ConfigOption; onPick: (v: string) => void }) {
  return (
    <DropdownMenu.RadioGroup value={option.current ?? ""} onValueChange={onPick}>
      {option.choices.map((c) => (
        <DropdownMenu.RadioItem key={c.value} value={c.value} className={ITEM}>
          {c.name}
          <DropdownMenu.ItemIndicator className="absolute right-2 flex size-3.5 items-center justify-center">
            <Check className="size-4" aria-hidden />
          </DropdownMenu.ItemIndicator>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

export function ModelMenu({
  scope,
  agent,
  model,
  effort,
  onSet,
}: {
  scope: string;
  agent: string;
  model: ConfigOption | null | undefined;
  effort: ConfigOption | null | undefined;
  onSet: (category: "model" | "thought_level", value: string) => void;
}) {
  const t = useT();
  const raised = useLiquidActiveAnchors();
  const menu = useLiquidMenu(`menu:${scope}:model`, `${scope}:model`);
  // The effort submenu grows out of its row in the model menu
  const sub = useLiquidMenu(`menu:${scope}:effort`, `${scope}:effort-row`);
  // Closing the whole menu (esc, a click outside, picking a level) removes the submenu without telling it, which would
  // leave its blob on screen; close the submenu's blob along with the menu
  const subOpen = useRef(false);
  const onSubOpenChange = (open: boolean) => {
    subOpen.current = open;
    sub.onOpenChange(open);
  };
  const onOpenChange = (open: boolean) => {
    if (!open && subOpen.current) onSubOpenChange(false);
    menu.onOpenChange(open);
  };
  if (!model && !effort) return null;
  const modelName = model ? (model.choices.find((c) => c.value === model.current)?.name ?? model.current) : null;
  const label = [model && t("composer.modelLabel"), effort && t("composer.effortLabel")].filter(Boolean).join(" / ");

  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={liquidAnchor(`${scope}:model`)}
          type="button"
          aria-label={label}
          className={cn(CHIP_TRIGGER, "relative flex items-center gap-1.5 whitespace-nowrap", raised.has(`${scope}:model`) && "z-[57]")}
        >
          {model && (
            <span className="flex items-center gap-1">
              <ProviderLogo agent={agent} className="size-3 text-muted-foreground" />
              <span>{modelName}</span>
            </span>
          )}
          {effort && (
            <span className="flex items-center gap-1.5">
              <EffortBars effort={effort} />
              <span className="text-muted-foreground">{effort.current}</span>
            </span>
          )}
          {/* Wrapped: the chip style hides a trailing svg (meant for Select's own chevron) */}
          <span className="flex">
            <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden />
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={menu.ref as React.Ref<HTMLDivElement>}
          style={menu.style}
          side="top"
          align="start"
          sideOffset={6}
          className={cn(CONTENT, menu.moving && "opacity-0")}
        >
          {model ? (
            <Choices option={model} onPick={(v) => onSet("model", v)} />
          ) : (
            effort && <Choices option={effort} onPick={(v) => onSet("thought_level", v)} />
          )}
          {model && effort && (
            <>
              <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
              <DropdownMenu.Sub onOpenChange={onSubOpenChange}>
                <DropdownMenu.SubTrigger ref={liquidAnchor(`${scope}:effort-row`)} className={cn(ITEM, "pr-2")}>
                  <EffortBars effort={effort} />
                  {t("composer.effortLabel")}
                  <span className="ml-auto text-xs text-muted-foreground">{effort.current}</span>
                  <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    ref={sub.ref as React.Ref<HTMLDivElement>}
                    style={sub.style}
                    sideOffset={6}
                    alignOffset={-4}
                    className={cn(CONTENT, "min-w-[9rem]", sub.moving && "opacity-0")}
                  >
                    <Choices option={effort} onPick={(v) => onSet("thought_level", v)} />
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
