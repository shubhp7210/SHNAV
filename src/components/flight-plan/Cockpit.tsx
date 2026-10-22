import { Lock, Plane, Eye, Compass, Volume2, VolumeX, RotateCcw } from "lucide-react";
import type { CameraMode } from "@/lib/cesium/cameraModes";

interface CockpitProps {
  heading: number;              // degrees
  speedKmh: number;
  progress: number;             // 0..1
  status: "nominal" | "alert";
  distanceKm: number | null;    // remaining to destination (null if unknown)
  lastUpdateMs: number;         // timestamp of last telemetry sample
  now: number;                  // current tick (for stale calc / "ago" label)
  cameraMode: CameraMode;
  onMode: (m: CameraMode) => void;
  muted: boolean;
  onToggleMute: () => void;
}

const STALE_MS = 3000;

const MODE_BTN: { mode: CameraMode; label: string; Icon: typeof Plane }[] = [
  { mode: "follow", label: "Follow", Icon: Lock },
  { mode: "forward", label: "Forward", Icon: Plane },
  { mode: "overview", label: "Overview", Icon: Eye },
  { mode: "free", label: "Explore", Icon: Compass },
];

/** Compact translucent cockpit overlay. Honest about missing/stale telemetry —
 *  never presents unknown or stale values as confirmed live data. */
export default function Cockpit({
  heading, speedKmh, progress, status, distanceKm, lastUpdateMs, now,
  cameraMode, onMode, muted, onToggleMute,
}: CockpitProps) {
  const ageMs = Math.max(0, now - lastUpdateMs);
  const stale = ageMs > STALE_MS;
  const pct = Math.round(progress * 100);

  const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="flex flex-col leading-none">
      <span className="text-[9px] font-mono uppercase tracking-widest text-white/45">{label}</span>
      <span className="text-sm font-mono font-bold text-white/90">
        {value}{sub && <span className="text-[10px] font-normal text-white/45 ml-0.5">{sub}</span>}
      </span>
    </div>
  );

  // Dark translucent panel + light text: legible on BOTH the bright Cesium map
  // and the dark canvas fallback (a white panel would vanish on the dark map).
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 p-3">
      <div className="rounded-xl border border-white/15 bg-slate-950/70 backdrop-blur-md px-3 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-2.5 shadow-lg">
        {/* Camera modes */}
        <div className="flex items-center gap-1">
          {MODE_BTN.map(({ mode, label, Icon }) => (
            <button
              key={mode}
              onClick={() => onMode(mode)}
              className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-mono font-semibold transition-colors border ${
                cameraMode === mode
                  ? "bg-primary/25 border-primary/50 text-primary"
                  : "bg-black/20 border-white/10 text-white/55 hover:border-white/25"
              }`}
              title={`${label} camera`}
            >
              <Icon className="w-3 h-3" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
          <button
            onClick={() => onMode("follow")}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-mono font-semibold border bg-black/20 border-white/10 text-white/55 hover:border-white/25"
            title="Recenter on vehicle"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>

        <div className="h-6 w-px bg-white/10 hidden md:block" />

        {/* Telemetry — honest states */}
        <div className="flex items-center gap-4 flex-wrap">
          <Stat label="Speed" value={speedKmh > 0 ? String(Math.round(speedKmh)) : "—"} sub="km/h" />
          <Stat label="Heading" value={`${Math.round(((heading % 360) + 360) % 360)}`} sub="°" />
          <Stat label="Dist" value={distanceKm != null ? distanceKm.toFixed(1) : "—"} sub="km" />
          <Stat label="Progress" value={`${pct}`} sub="%" />
          {/* Altitude: no AGL/AMSL telemetry in the route data — shown honestly as unavailable. */}
          <Stat label="Alt (AGL)" value="—" sub="n/a" />
        </div>

        <div className="h-6 w-px bg-white/10 hidden md:block" />

        {/* Connection / freshness — never fabricated */}
        <div className="flex items-center gap-2 ml-auto">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${stale ? "bg-amber-400" : status === "alert" ? "bg-red-400 animate-pulse" : "bg-emerald-400 animate-pulse"}`} />
          <span className="text-[10px] font-mono text-white/60">
            {stale ? `STALE · ${Math.round(ageMs / 1000)}s ago` : "LIVE"}
          </span>
          <button
            onClick={onToggleMute}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-black/20 border border-white/10 text-white/55 hover:border-white/25"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
