/** Lightweight, CSS-only loading overlay shared by every map. */
export default function MapLoading() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none" role="status" aria-live="polite">
      <div className="flex items-center gap-2 rounded-lg bg-zinc-950/80 border border-white/10 px-3 py-2">
        <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
        <span className="text-[11px] font-mono tracking-widest text-white/70">LOADING MAP</span>
      </div>
    </div>
  );
}
