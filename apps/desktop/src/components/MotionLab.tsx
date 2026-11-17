import { animate, motion, useMotionValue, type PanInfo } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { useStore } from "@/state/store";
import {
  appleSpring,
  BOUNCY,
  INTERACTIVE,
  project,
  rubberBand,
  SMOOTH,
  SNAPPY,
  springConstants,
  springPosition,
  springToCss,
  type SpringParams,
} from "./motion";
import { Segmented } from "./Segmented";
import { liquidAnchor, useLiquidMorph, type LiquidStyle } from "./liquid/liquid";

/** requestAnimationFrame の間隔から、実際に描いている頻度を測る */
function useFrameRate() {
  const [hz, setHz] = useState<number | null>(null);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let start = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - start >= 1000) {
        setHz(Math.round((frames * 1000) / (now - start)));
        frames = 0;
        start = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return hz;
}

function Curve({ p }: { p: SpringParams }) {
  const t = useT();
  const W = 280;
  const H = 96;
  const { ms } = springToCss(p);
  const k = springConstants(p);
  const total = Math.max(ms / 1000, p.duration) * 1.1;
  const pts = Array.from({ length: 120 }, (_, i) => {
    const time = (total * i) / 119;
    const y = springPosition(k, time);
    return `${(W * i) / 119},${H - 12 - y * (H - 36)}`;
  }).join(" ");
  const target = H - 12 - (H - 36);
  return (
    <svg width={W} height={H} role="img" aria-label={t("motionLab.curveLabel")} className="rounded-lg bg-background">
      <line x1={0} x2={W} y1={target} y2={target} stroke="currentColor" className="text-border" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2} className="text-foreground" />
    </svg>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="w-16 text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="grow accent-foreground" />
      <span className="w-12 text-right font-mono tabular">{value.toFixed(2)}</span>
    </label>
  );
}

const CORNERS = (w: number, h: number) => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: 0, y: h },
  { x: w, y: h },
];

/** 投げると、Apple と同じ減速率で行き先を予測して四隅に吸い付く。枠の外ではゴムのように伸びる */
function ThrowCard({ p }: { p: SpringParams }) {
  const t = useT();
  const area = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const origin = useRef({ x: 0, y: 0 });
  const CARD = 72;
  const size = () => {
    const r = area.current?.getBoundingClientRect();
    return { w: (r?.width ?? 300) - CARD, h: (r?.height ?? 200) - CARD };
  };
  const clampRubber = (v: number, max: number, dim: number) => (v < 0 ? rubberBand(v, dim) : v > max ? max + rubberBand(v - max, dim) : v);

  return (
    <div ref={area} className="relative h-56 rounded-lg bg-background">
      {CORNERS(1, 1).map((c, i) => (
        <span key={i} aria-hidden className="absolute size-[72px] rounded-xl border border-dashed border-border" style={{ left: c.x ? undefined : 0, right: c.x ? 0 : undefined, top: c.y ? undefined : 0, bottom: c.y ? 0 : undefined }} />
      ))}
      <motion.div
        role="button"
        tabIndex={0}
        aria-label={t("motionLab.throwCardLabel")}
        style={{ x, y, width: CARD, height: CARD }}
        whileTap={{ scale: 1.06 }}
        className="absolute top-0 left-0 cursor-grab touch-none rounded-xl bg-primary active:cursor-grabbing"
        onPanStart={() => {
          x.stop();
          y.stop();
          origin.current = { x: x.get(), y: y.get() };
        }}
        onPan={(_, info: PanInfo) => {
          const { w, h } = size();
          x.set(clampRubber(origin.current.x + info.offset.x, w, w + CARD));
          y.set(clampRubber(origin.current.y + info.offset.y, h, h + CARD));
        }}
        onPanEnd={(_, info: PanInfo) => {
          const { w, h } = size();
          const px = project(x.get(), info.velocity.x);
          const py = project(y.get(), info.velocity.y);
          const target = CORNERS(w, h).reduce((best, c) => (Math.hypot(c.x - px, c.y - py) < Math.hypot(best.x - px, best.y - py) ? c : best));
          // 指の勢いをそのまま引き継いで、ばねで吸い付く
          animate(x, target.x, appleSpring(p, info.velocity.x));
          animate(y, target.y, appleSpring(p, info.velocity.y));
        }}
      />
    </div>
  );
}

// 名前と説明は辞書のキー（言語が途中で変わるため、描くときに引く）
const STYLES: { value: LiquidStyle; label: MessageKey; note: MessageKey }[] = [
  { value: "pop", label: "motionLab.stylePop", note: "motionLab.stylePopNote" },
  { value: "morph", label: "motionLab.styleMorph", note: "motionLab.styleMorphNote" },
  { value: "tear", label: "motionLab.styleTear", note: "motionLab.styleTearNote" },
  { value: "droplet", label: "motionLab.styleDroplet", note: "motionLab.styleDropletNote" },
];

/** 分離アニメーションの見本。選んだ型は検索カード（⌘K）にも使われる */
function SeparationDemo() {
  const t = useT();
  const style = useStore((s) => s.liquidStyle);
  const setStyle = useStore((s) => s.setLiquidStyle);
  const lag = useStore((s) => s.liquidLag);
  const setLag = useStore((s) => s.setLiquidLag);
  const [open, setOpen] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const { revealed, mounted, layer } = useLiquidMorph(open, { anchor: "lab-src", target, radius: 12, anchorRadius: 8, style, sizeLag: lag });
  const note = STYLES.find((s) => s.value === style)?.note;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{t("motionLab.separationStyle")}</span>
        <Segmented<LiquidStyle> label={t("motionLab.separationStyle")} value={style} onChange={setStyle} options={STYLES.map((s) => ({ value: s.value, label: t(s.label) }))} />
      </div>
      <p className="text-xs text-muted-foreground">{note && t(note)}</p>
      {style === "pop" && <Slider label={t("motionLab.sizeLag")} value={lag} min={0} max={0.3} step={0.01} onChange={setLag} />}
      <div className="relative h-44 rounded-lg bg-background p-3">
        <button
          ref={liquidAnchor("lab-src")}
          type="button"
          onClick={() => setOpen(!open)}
          className="flex h-7 w-40 items-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {open ? t("motionLab.close") : t("motionLab.open")}
        </button>
        {mounted && (
          <div
            ref={target}
            className={cn(
              "absolute top-6 right-4 flex h-32 w-64 flex-col gap-2 rounded-xl border bg-muted p-3 text-xs transition-opacity duration-150",
              revealed ? "opacity-100" : "opacity-0",
            )}
          >
            <span className="font-medium text-foreground">{t("motionLab.openedSurface")}</span>
            <span className="text-muted-foreground">{t("motionLab.openedSurfaceNote")}</span>
          </div>
        )}
      </div>
      {layer}
    </div>
  );
}

export function MotionLab() {
  const t = useT();
  const open = useStore((s) => s.labOpen);
  const setOpen = useStore((s) => s.setLabOpen);
  const hz = useFrameRate();
  const [p, setP] = useState<SpringParams>(SNAPPY);
  const [pos, setPos] = useState(0);
  const [on, setOn] = useState(false);
  const k = useMemo(() => springConstants(p), [p]);
  const { ms } = useMemo(() => springToCss(p), [p]);
  const presets: [string, SpringParams][] = [
    ["smooth", SMOOTH],
    ["snappy", SNAPPY],
    ["bouncy", BOUNCY],
    ["interactive", INTERACTIVE],
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[880px]">
        <DialogHeader>
          <DialogTitle>{t("motionLab.title")}</DialogTitle>
          <DialogDescription>{t("motionLab.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t("motionLab.frameRate")}</span>
              <span className={cn("font-mono tabular", hz !== null && hz < 100 && "text-permission")}>{hz === null ? t("motionLab.measuring") : `${hz} Hz`}</span>
            </div>
            {hz !== null && hz < 100 && <p className="text-xs text-muted-foreground">{t("motionLab.throttled")}</p>}
            <Segmented<string>
              label={t("motionLab.preset")}
              value={presets.find(([, v]) => v.duration === p.duration && v.bounce === p.bounce)?.[0] ?? "custom"}
              onChange={(name) => setP(presets.find(([n]) => n === name)?.[1] ?? p)}
              options={presets.map(([n]) => ({ value: n, label: n }))}
            />
            <Slider label="duration" value={p.duration} min={0.1} max={1.5} step={0.01} onChange={(duration) => setP({ ...p, duration })} />
            <Slider label="bounce" value={p.bounce} min={-0.5} max={0.8} step={0.01} onChange={(bounce) => setP({ ...p, bounce })} />
            <Curve p={p} />
            <dl className="grid grid-cols-3 gap-2 font-mono text-xs tabular">
              <div>
                <dt className="text-muted-foreground">stiffness</dt>
                <dd>{k.stiffness.toFixed(1)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">damping</dt>
                <dd>{k.damping.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("motionLab.settle")}</dt>
                <dd>{ms} ms</dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className={cn("flex h-10 grow rounded-lg bg-background p-1", pos ? "justify-end" : "justify-start")}>
                <motion.span layout transition={appleSpring(p)} className="block size-8 rounded-md bg-primary" />
              </div>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setPos(pos ? 0 : 1)}>
                {t("motionLab.move")}
              </Button>
            </div>
            <div className="flex items-center gap-4">
              <motion.button
                type="button"
                whileTap={{ scale: 1.08 }}
                transition={appleSpring(INTERACTIVE)}
                className="h-9 rounded-xl bg-muted px-4"
              >
                {t("motionLab.pressToGrow")}
              </motion.button>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={on} onCheckedChange={setOn} />
                {t("motionLab.cssSwitch")}
              </label>
            </div>
            <SeparationDemo />
            <ThrowCard p={p} />
            <p className="text-xs text-muted-foreground">{t("motionLab.throwNote")}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
