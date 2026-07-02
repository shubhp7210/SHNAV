import { Wind, Eye, Crosshair, Compass } from "lucide-react";
import { kmhToKnots } from "@/lib/aviation";

export type PovMode = "fpv" | "tac" | "hyb";

interface HudOverlayProps {
  heading: number;             // 0–360 degrees, magnetic
  speedKmh: number;
  windSpeed: number | null;    // km/h; converted to knots for display
  povMode: PovMode;
  autoPov: boolean;
  onPovChange: (m: PovMode) => void;
  onToggleAutoPov: () => void;
  /** 1–12; null when no active drift alert */
  driftClock: number | null;
  driftSeverity?: "low" | "moderate" | "high";
}

// Three-figure heading: 5 → "005", 90 → "090"
function fmtHeading(h: number): string {
  const v = Math.round(((h % 360) + 360) % 360);
  return v.toString().padStart(3, "0");
}

function cardinal(h: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((((h % 360) + 360) % 360) / 45) % 8];
}

const POV_LABEL: Record<PovMode, string> = { fpv: "FPV", tac: "TAC", hyb: "HYB" };

export default function HudOverlay({
  heading, speedKmh, windSpeed, povMode, autoPov,
  onPovChange, onToggleAutoPov, driftClock, driftSeverity = "moderate",
}: HudOverlayProps) {
  const sevColor =
    driftSeverity === "high" ? "text-red-400 border-red-500/60 bg-red-500/10"
    : driftSeverity === "moderate" ? "text-amber-300 border-amber-500/50 bg-amber-500/10"
    : "text-yellow-300 border-yellow-500/40 bg-yellow-500/10";

  return (
    <>
      {/* Top-center compass — three-figure magnetic heading */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full
                        bg-black/55 border border-primary/40 backdrop-blur-md
                        shadow-[0_0_18px_-4px_rgba(45,212,191,0.55)]">
          <Compass
            className="w-3.5 h-3.5 text-primary transition-transform duration-500"
            style={{ transform: `rotate(${-heading}deg)` }}
          />
          <span className="font-mono font-bold text-sm text-primary tracking-wider tabular-nums">
            {fmtHeading(heading)}°
          </span>
          <span className="text-[10px] font-mono text-white/50 uppercase">{cardinal(heading)}</span>
          <span className="w-px h-3 bg-white/15" />
          <span className="text-[10px] font-mono text-white/50 tabular-nums">
            {Math.round(speedKmh)} km/h
          </span>
        </div>
      </div>

      {/* Top-right POV switcher */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5
                      bg-black/55 border border-white/10 backdrop-blur-md
                      rounded-full p-1">
        {(["fpv", "tac", "hyb"] as PovMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onPovChange(m)}
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold tracking-wider
              transition-all duration-150 ${
                povMode === m
                  ? "bg-primary text-primary-foreground shadow-[0_0_10px_-2px_rgba(45,212,191,0.7)]"
                  : "text-white/55 hover:text-white"
              }`}
            title={`${POV_LABEL[m]} view`}
          >
            {POV_LABEL[m]}
          </button>
        ))}
        <span className="w-px h-3 bg-white/15 mx-0.5" />
        <button
          onClick={onToggleAutoPov}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono
            transition-all duration-150 ${
              autoPov ? "text-primary" : "text-white/40 hover:text-white/70"
            }`}
          title="Adaptive POV — auto-switch on sharp turns"
        >
          <Eye className="w-2.5 h-2.5" /> AUTO
        </button>
      </div>

      {/* Bottom-right wind indicator */}
      {windSpeed !== null && (
        <div className="absolute bottom-4 right-4 z-10 pointer-events-none">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full
                          bg-black/55 border border-white/10 backdrop-blur-md">
            <Wind className="w-3 h-3 text-cyan-300" />
            <span className="font-mono text-[11px] text-white/80 tabular-nums">
              {Math.round(kmhToKnots(windSpeed))} kt
            </span>
          </div>
        </div>
      )}

      {/* Clock-code drift alert (only when off-route) */}
      {driftClock !== null && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 pointer-events-none animate-fade-in">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border backdrop-blur-md
                           ${sevColor}`}>
            <Crosshair className="w-3.5 h-3.5" />
            <span className="font-mono text-[11px] font-bold tracking-wider">
              DRIFT · {driftClock} O&apos;CLOCK
            </span>
          </div>
        </div>
      )}
    </>
  );
}
