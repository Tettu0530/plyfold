import { motion } from "motion/react";
import { useId } from "react";

import { cn } from "@/lib/utils";
import { spring, squashX } from "./motion";

interface Props<T extends string | number> {
  label: string;
  value: T;
  options: { value: T; label: React.ReactNode; aria?: string }[];
  onChange: (v: T) => void;
  className?: string;
}

/** 液体の切り替え: 選択の印がばねで流れ、着くと潰れてぽよんと戻る */
export function Segmented<T extends string | number>({ label, value, options, onChange, className }: Props<T>) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn("relative flex rounded-lg bg-muted p-0.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.aria}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative z-0 flex h-[22px] min-w-[26px] items-center justify-center px-2 text-xs transition-colors",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span layoutId={`thumb-${id}`} transition={spring} className="absolute inset-0 -z-10">
                <motion.span
                  key={String(value)}
                  {...squashX}
                  className="block size-full rounded-md bg-background shadow-[0_1px_2px_rgba(0,0,0,.4)]"
                />
              </motion.span>
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
