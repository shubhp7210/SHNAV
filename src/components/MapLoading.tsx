/** Lightweight, CSS-only loading overlay shared by every map. */
export default function MapLoading() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-[radial-gradient(ellipse_at_center,hsl(var(--background)/0.2),hsl(var(--background)/0.85))]" role="status" aria-live="polite">
      <div className="flex items-center gap-3 rounded-full bg-background/80 border border-border px-4 py-2 backdrop-blur-md shadow-elev">
        <span className="relative flex w-3 h-3">
          <span className="absolute inset-0 rounded-full bg-signal/50 animate-ping" />
          <span className="relative w-3 h-3 rounded-full bg-signal" />
        </span>
        <span className="text-[11px] font-mono tracking-[0.2em] text-foreground/70">ACQUIRING MANHATTAN 3D</span>
      </div>
    </div>
  );
}
