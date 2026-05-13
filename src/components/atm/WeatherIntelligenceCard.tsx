// Operational weather panel. No reassurance copy ("Proceed!", "Looks good!") —
// just the facts a pilot uses to make decisions: wind/gusts with direction,
// visibility, temperature, turbulence/icing probabilities, trend forecast.
import { motion } from "framer-motion";
import { Wind, Droplets, Thermometer, Eye, TrendingUp, TrendingDown, Minus, AlertTriangle } from "lucide-react";
import type { WeatherIntelligenceResult } from "@/lib/atmTypes";
import { windCallout, formatHeading, cardinalLabel, kmhToKnots } from "@/lib/aviation";

interface Props {
  weather: WeatherIntelligenceResult;
}

const RISK_COLOR = {
  low: { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  moderate: { text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
  high: { text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
};

function RiskBar({ score, label }: { score: number; label: string }) {
  const color = score >= 60 ? "bg-red-500" : score >= 30 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex justify-between text-[10px] text-white/40 mb-1">
        <span>{label}</span>
        <span className={score >= 60 ? "text-red-400" : score >= 30 ? "text-amber-400" : "text-emerald-400"}>
          {score}/100
        </span>
      </div>
      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className={`h-full rounded-full ${color}`}
        />
      </div>
    </div>
  );
}

// Derive hazard probabilities a pilot actually wants to see — turbulence,
// icing, crosswind — from the raw weather fields we already collect.
function operationalHazards(weather: WeatherIntelligenceResult): {
  turbulencePct: number;
  icingPct: number;
  crosswindKnots: number | null;
  stormCode: number;
} {
  const ow = weather.origin_weather;
  const gusts = ow.wind_gusts ?? 0;
  const wind = ow.wind_speed ?? 0;
  // Turbulence proxy: gusts dominate, plus the gust-wind spread.
  const spread = Math.max(0, gusts - wind);
  const turb = Math.min(100, Math.round(gusts * 1.0 + spread * 1.6));
  // Icing proxy: cold + precipitation.
  let icing = 0;
  if (typeof ow.temperature === "number" && ow.temperature <= 2 && (ow.precipitation ?? 0) > 0) {
    icing = ow.temperature <= -2 ? 70 : 35;
  }
  if (ow.weather_code >= 56 && ow.weather_code <= 67) icing = Math.max(icing, 55); // freezing rain codes
  // Storm activity from weather code.
  const stormCode = ow.weather_code ?? 0;
  return { turbulencePct: turb, icingPct: icing, crosswindKnots: null, stormCode };
}

export default function WeatherIntelligenceCard({ weather }: Props) {
  const ow = weather.origin_weather;
  const riskCfg = RISK_COLOR[ow.risk_level] ?? RISK_COLOR.low;
  const TrendIcon =
    weather.forecast.trend === "improving" ? TrendingDown :
    weather.forecast.trend === "degrading" ? TrendingUp : Minus;
  const trendColor =
    weather.forecast.trend === "improving" ? "text-emerald-400" :
    weather.forecast.trend === "degrading" ? "text-red-400" : "text-white/40";

  const hazards = operationalHazards(weather);
  // The backend may or may not include wind_direction_deg; treat as optional.
  const windDirDeg = (ow as { wind_direction_deg?: number }).wind_direction_deg;
  const windLine = typeof windDirDeg === "number"
    ? windCallout(windDirDeg, ow.wind_speed ?? 0, ow.wind_gusts ?? undefined)
    : `Wind ${Math.round(kmhToKnots(ow.wind_speed ?? 0))} knots, gusts ${Math.round(kmhToKnots(ow.wind_gusts ?? 0))}`;

  // Storm activity callout from WMO weather code.
  const stormLabel =
    hazards.stormCode >= 95 ? "Thunderstorm in area" :
    hazards.stormCode >= 80 ? "Showers in area" :
    hazards.stormCode >= 71 ? "Snow in area" :
    hazards.stormCode >= 61 ? "Rain in area" :
    hazards.stormCode >= 51 ? "Drizzle" :
    null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="rounded-xl border border-white/10 bg-white/5 overflow-hidden"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
        <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">Weather &amp; Flight Awareness</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${riskCfg.text} ${riskCfg.bg} ${riskCfg.border}`}>
          {ow.risk_level.toUpperCase()}
        </span>
      </div>

      <div className="p-5 space-y-4">
        {/* Aviation-style wind callout */}
        <div className="rounded-md bg-cyan-500/5 border border-cyan-500/20 px-3 py-2 flex items-center gap-2">
          <Wind className="w-4 h-4 text-cyan-300 shrink-0" />
          <span className="font-mono text-sm text-white">{windLine}</span>
          {typeof windDirDeg === "number" && (
            <span className="ml-auto text-[10px] font-mono text-cyan-300/70">
              {formatHeading(windDirDeg)} {cardinalLabel(windDirDeg)}
            </span>
          )}
        </div>

        {/* Operational metrics grid — facts, not advice */}
        <div className="grid grid-cols-4 gap-2">
          {[
            {
              icon: Wind,
              label: "Wind",
              value: `${Math.round(kmhToKnots(ow.wind_speed ?? 0))} kt`,
              sub: `Gusts ${Math.round(kmhToKnots(ow.wind_gusts ?? 0))}`,
            },
            {
              icon: Droplets,
              label: "Precip",
              value: `${ow.precipitation} mm`,
              sub: ow.weather_description ?? "—",
            },
            {
              icon: Thermometer,
              label: "Temp",
              value: `${Math.round(ow.temperature ?? 0)}°C`,
              sub: ow.temperature != null && ow.temperature <= 2 ? "Icing risk" : "Within limits",
            },
            {
              icon: Eye,
              label: "Visibility",
              value: (ow.visibility_m ?? 0) >= 10000
                ? "10+ km"
                : `${((ow.visibility_m ?? 0) / 1000).toFixed(1)} km`,
              sub: (ow.visibility_m ?? 0) < 3000 ? "Below VFR" : (ow.visibility_m ?? 0) < 5000 ? "Marginal" : "VFR",
            },
          ].map(({ icon: Ic, label, value, sub }) => (
            <div key={label} className="bg-black/20 rounded-lg p-2.5 text-center">
              <Ic className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
              <p className="text-[10px] text-white/40">{label}</p>
              <p className="text-xs font-bold text-white">{value}</p>
              <p className="text-[9px] text-white/30">{sub}</p>
            </div>
          ))}
        </div>

        {/* Hazard probabilities */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-black/20 rounded-md px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-white/40 uppercase tracking-widest">Turbulence</span>
              <span className={`text-xs font-mono font-bold ${hazards.turbulencePct >= 60 ? "text-red-400" : hazards.turbulencePct >= 30 ? "text-amber-400" : "text-emerald-400"}`}>
                {hazards.turbulencePct}%
              </span>
            </div>
          </div>
          <div className="bg-black/20 rounded-md px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-white/40 uppercase tracking-widest">Icing</span>
              <span className={`text-xs font-mono font-bold ${hazards.icingPct >= 50 ? "text-red-400" : hazards.icingPct >= 20 ? "text-amber-400" : "text-emerald-400"}`}>
                {hazards.icingPct}%
              </span>
            </div>
          </div>
        </div>

        {stormLabel && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-xs text-amber-200 font-mono">{stormLabel}</span>
          </div>
        )}

        {/* Risk forecast trend (timeline) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-white/40 uppercase tracking-widest">Risk Forecast</span>
            <TrendIcon className={`w-3 h-3 ${trendColor}`} />
            <span className={`text-[10px] ${trendColor}`}>{weather.forecast.trend}</span>
          </div>
          <div className="space-y-2">
            <RiskBar score={ow.risk_score} label="Now" />
            <RiskBar score={weather.forecast.t_plus_15.risk_score} label="+15 min" />
            <RiskBar score={weather.forecast.t_plus_30.risk_score} label="+30 min" />
          </div>
          <div className="flex justify-between text-[9px] text-white/25 mt-1">
            <span>±{weather.forecast.t_plus_15.uncertainty_pct}% at +15</span>
            <span>±{weather.forecast.t_plus_30.uncertainty_pct}% at +30</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
