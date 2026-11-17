// The Plyfold mark: a P made of two panes, a tall one with a folded corner and a rounded one beside it (ply and fold).
// Drawn in the current text color; the folded corner is the same color at lower opacity, so it works on any surface
export function PlyfoldMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M16 21 A9 9 0 0 1 25 12 H31 L44 25 V79 A9 9 0 0 1 35 88 H25 A9 9 0 0 1 16 79 Z" fill="currentColor" />
      <path d="M31 12 L44 25 H34 A3 3 0 0 1 31 22 Z" fill="currentColor" fillOpacity={0.55} />
      <path d="M58 12 H61 A23 23 0 0 1 61 58 H58 A8 8 0 0 1 50 50 V20 A8 8 0 0 1 58 12 Z" fill="currentColor" />
    </svg>
  );
}
