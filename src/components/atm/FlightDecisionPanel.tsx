import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle, Clock, RefreshCw, Shield, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import type { FlightDecisionResult } from "@/lib/atmTypes";

interface Props {
  decision: FlightDecisionResult;
  loading?: boolean;
}

const DECISION_CONFIG = {
  GO: {
    icon: CheckCircle,
    label: "CLEARED TO GO",
    bg: "from-emerald-900/60 to-emerald-800/30",
    border: "border-emerald-500/50",
    glow: "shadow-emerald-500/20",
    iconColor: "text-emerald-400",
    badgeBg: "bg-emerald-500",
    ring: "#10b981",
  },
  DELAY: {
    icon: Clock,
    label: "DELAY ISSUED",
    bg: "from-amber-900/60 to-amber-800/30",
    border: "border-amber-500/50",
    glow: "shadow-amber-500/20",
    iconColor: "text-amber-400",
    badgeBg: "bg-amber-500",
    ring: "#f59e0b",
  },
  REROUTE: {
    icon: RefreshCw,
    label: "REROUTE REQUIRED",
    bg: "from-sky-900/60 to-sky-800/30",
    border: "border-sky-500/50",
    glow: "shadow-sky-500/20",
    iconColor: "text-sky-400",
    badgeBg: "bg-sky-500",
    ring: "#0ea5e9",
  },
};

export default function FlightDecisionPanel({ decision, loading }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 animate-pulse">
        <div className="h-8 w-48 bg-white/10 rounded mb-4" />
        <div className="h-4 w-full bg-white/10 rounded mb-2" />
        <div className="h-4 w-3/4 bg-white/10 rounded" />
      </div>
    );
  }

  const cfg = DECISION_CONFIG[decision.decision];
  const Icon = cfg.icon;
  const depTime = new Date(decision.departure_time);
  const depStr = depTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={`rounded-xl border ${cfg.border} bg-gradient-to-br ${cfg.bg} shadow-xl ${cfg.glow} overflow-hidden`}
    >
      {/* Header */}
      <div className="flex items-center gap-4 p-5 border-b border-white/10">
        <motion.div
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          className={`p-3 rounded-full bg-black/20 ${cfg.iconColor}`}
        >
          <Icon className="w-7 h-7" />
        </motion.div>
        <div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white ${cfg.badgeBg}`}>
              ATM DECISION
            </span>
            <span className="text-xs text-white/40">AUTO-GENERATED</span>
          </div>
          <h2 className="text-2xl font-black text-white tracking-wide mt-0.5">{cfg.label}</h2>
        </div>

        {/* Confidence ring */}
        <div className="ml-auto text-center">
          <div className="relative w-14 h-14">
            <svg viewBox="0 0 56 56" className="w-full h-full -rotate-90">
              <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="4" />
              <circle
                cx="28" cy="28" r="22" fill="none"
                stroke={cfg.ring} strokeWidth="4"
                strokeDasharray={`${2 * Math.PI * 22}`}
                strokeDashoffset={`${2 * Math.PI * 22 * (1 - decision.confidence / 100)}`}
                strokeLinecap="round"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">
              {decision.confidence}%
            </span>
          </div>
          <p className="text-[10px] text-white/40 mt-0.5">Confidence</p>
        </div>
      </div>

      {/* Decision details */}
      <div className="p-5 space-y-4">
        {/* Reason */}
        <p className="text-sm text-white/80 leading-relaxed">{decision.reason}</p>

        {/* Essential info — clean two-up */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-black/20 rounded-lg p-3">
            <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1">Departure</p>
            <p className="text-base font-bold text-white">{depStr}</p>
            {decision.delay_minutes > 0 && (
              <p className="text-xs text-amber-400">+{decision.delay_minutes} min hold</p>
            )}
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1">Status</p>
            <p className="text-base font-bold text-white flex items-center gap-1.5">
              {decision.simulation.safe ? <Shield className="w-4 h-4 text-emerald-400" /> : <AlertTriangle className="w-4 h-4 text-amber-400" />}
              {decision.simulation.safe ? "Safe corridor" : "Caution"}
            </p>
            <p className="text-xs text-white/40">Weather {decision.inputs_summary.weather_risk}</p>
          </div>
        </div>

        {/* Technical details — hidden by default */}
        <button
          onClick={() => setShowDetails((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-mono text-white/40 hover:text-white/70 transition-colors"
        >
          {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {showDetails ? "Hide" : "Show"} technical details
        </button>
        {showDetails && (
          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-white/60 border-t border-white/10 pt-3">
            <div>Trajectory: <span className="text-white">{decision.inputs_summary.trajectory_score}/100</span></div>
            <div>Conflicts: <span className="text-white">{decision.inputs_summary.conflicts}</span></div>
            <div>Airspace load: <span className="text-white">{decision.inputs_summary.airspace_load}%</span></div>
            <div>Route score: <span className="text-white">{decision.inputs_summary.route_score}/100</span></div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
