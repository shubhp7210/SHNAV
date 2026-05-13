import { motion, AnimatePresence } from "framer-motion";
import { Plane, ArrowUpDown, Gauge, Navigation } from "lucide-react";
import type { TrajectoryPredictorResult, FutureConflict } from "@/lib/atmTypes";
import { resolutionCallout, trafficCallout } from "@/lib/aviation";

interface Props {
  data: TrajectoryPredictorResult;
  /** Optional: own-ship heading so we can build clock-position callouts. */
  ownHeadingDeg?: number;
}

const SEVERITY = {
  high: { color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30", pulse: "bg-red-400" },
  moderate: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30", pulse: "bg-amber-400" },
  low: { color: "text-yellow-400", bg: "bg-yellow-500/5", border: "border-yellow-500/20", pulse: "bg-yellow-400" },
};

const RESOLUTION_ICON = {
  altitude_adjustment: ArrowUpDown,
  speed_adjustment: Gauge,
  route_deviation: Navigation,
};

function ConflictRow({ c, ownHeadingDeg }: { c: FutureConflict; ownHeadingDeg?: number }) {
  const s = SEVERITY[c.severity];
  const ResIcon = RESOLUTION_ICON[c.resolution.type] ?? Navigation;
  // Aviation-style resolution phrasing — overrides whatever raw text the
  // backend sent so the UI speaks in pilot terms.
  const resolutionText = resolutionCallout(
    c.resolution.type as "route_deviation" | "speed_adjustment" | "altitude_adjustment",
    ownHeadingDeg ?? 0,
    c.severity === "high" ? 25 : c.severity === "moderate" ? 15 : 10
  );
  // Build a traffic callout from clock position if we have a heading.
  const trafficText = typeof ownHeadingDeg === "number"
    ? trafficCallout(ownHeadingDeg, (ownHeadingDeg + (c.severity === "high" ? 30 : 60)) % 360, c.separation_km)
    : `Traffic: ${c.aircraft_a} vs ${c.aircraft_b}, ${c.separation_km} km separation`;

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      className={`rounded-lg border ${s.border} ${s.bg} p-3`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${s.pulse} animate-pulse`} />
          <span className={`text-xs font-bold ${s.color}`}>{c.severity.toUpperCase()} CONFLICT</span>
          <span className="text-[10px] text-white/30">T+{c.t_plus_min}min</span>
        </div>
        <span className="text-[10px] text-white/30">{c.separation_km} km sep.</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-white/70">
        <Plane className="w-3 h-3" />
        <span className="font-mono">{trafficText}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-2 text-[11px] text-cyan-300/80">
        <ResIcon className="w-3 h-3 text-cyan-400 flex-shrink-0" />
        <span className="font-mono">{resolutionText}</span>
      </div>
    </motion.div>
  );
}

export default function TrajectoryConflictAlert({ data, ownHeadingDeg }: Props) {
  const hasConflicts = data.future_conflicts.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.25 }}
      className="rounded-xl border border-white/10 bg-white/5 overflow-hidden"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
        <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">Trajectory Prediction</span>
        <span className={`text-xs font-bold ${data.high_severity_conflicts > 0 ? "text-red-400" : hasConflicts ? "text-amber-400" : "text-emerald-400"}`}>
          {data.total_conflicts_detected} CONFLICT{data.total_conflicts_detected !== 1 ? "S" : ""} DETECTED
        </span>
      </div>

      <div className="p-5 space-y-4">
        {/* System flow */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-black/20 rounded-lg p-2.5 text-center">
            <p className="text-[10px] text-white/40">Active Flights</p>
            <p className="text-lg font-bold text-white">{data.total_active_flights}</p>
          </div>
          <div className="bg-black/20 rounded-lg p-2.5 text-center">
            <p className="text-[10px] text-white/40">Flow Efficiency</p>
            <p className={`text-lg font-bold ${data.system_flow_efficiency >= 80 ? "text-emerald-400" : data.system_flow_efficiency >= 60 ? "text-amber-400" : "text-red-400"}`}>
              {data.system_flow_efficiency}%
            </p>
          </div>
          <div className="bg-black/20 rounded-lg p-2.5 text-center">
            <p className="text-[10px] text-white/40">Horizon</p>
            <p className="text-lg font-bold text-white">{data.analysis_horizon_minutes}m</p>
          </div>
        </div>

        {/* Conflicts */}
        <AnimatePresence>
          {hasConflicts ? (
            <div className="space-y-2">
              {data.future_conflicts.slice(0, 4).map((c, i) => (
                <ConflictRow key={i} c={c} ownHeadingDeg={ownHeadingDeg} />
              ))}
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2 text-emerald-400 text-sm bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3"
            >
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              No future conflicts detected in {data.analysis_horizon_minutes}-minute horizon
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
