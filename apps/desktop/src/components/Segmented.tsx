import { motion } from "motion/react";
import { useId } from "react";

import { cn } from "@/lib/utils";
import { press, snappy } from "./motion";

interface Props<T extends string | number> {
  label: string;
  value: T;
  options: { value: T; label: React.ReactNode; aria?: string }[];
  onChange: (v: T) => void;
  className?: string;
}

/** Liquid segmented control: the selection indicator flows on a spring, squashes on arrival and bounces back */
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
              <motion.span
                layoutId={`thumb-${id}`}
                whileTap={press.whileTap}
                transition={{ layout: snappy, scale: press.transition }}
                className="absolute inset-0 -z-10 rounded-md bg-background shadow-[0_1px_2px_rgba(0,0,0,.4)]"
              />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
