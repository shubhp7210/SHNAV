import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  AlertTriangle,
  Wind,
  Thermometer,
  CloudRain,
  Eye,
} from "lucide-react";
import type { RouteOptimizerResult, RouteCandidate, ConflictDetail } from "@/lib/routeTypes";
import RouteScoreBar from "./RouteScoreBar";

interface Props {
  routeData: RouteOptimizerResult | null;
  routeLoading: boolean;
  selectedRouteId?: string | null;
  onSelectRoute?: (routeId: string) => void | Promise<void>;
}

function scoreRingColor(score: number): string {
  if (score >= 80) return "border-green-500 text-green-400";
  if (score >= 60) return "border-yellow-500 text-yellow-400";
  return "border-red-500 text-red-400";
}

function severityBadge(severity: ConflictDetail["severity"]): string {
  if (severity === "high") return "bg-red-500/20 text-red-400 border border-red-500/30";
  if (severity === "moderate") return "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30";
  return "bg-blue-500/20 text-blue-400 border border-blue-500/30";
}

interface AlternateCardProps {
  route: RouteCandidate;
  selected: boolean;
  onSelect?: () => void;
}

const AlternateCard = ({ route, selected, onSelect }: AlternateCardProps) => {
  return (
    <div
      className={`border rounded-lg p-3 transition-colors ${
        selected ? "border-primary/60 bg-primary/5" : "border-border/50 bg-card/40 hover:border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`text-xs font-mono px-2 py-0.5 rounded-full border shrink-0 ${scoreRingColor(route.overall_score)}`}
          >
            {route.overall_score}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{route.label}</p>
            <p className="text-xs text-muted-foreground font-mono">
              {route.distance_km} km · {route.estimated_time_min} min
            </p>
          </div>
        </div>
        {selected ? (
          <span className="text-xs font-mono text-primary px-2 py-1 rounded-md border border-primary/40 bg-primary/10 shrink-0">
            Selected
          </span>
        ) : (
          <button
            onClick={onSelect}
            className="text-xs font-mono text-primary px-2.5 py-1 rounded-md border border-primary/40 hover:bg-primary/10 transition-colors shrink-0"
          >
            Use route
          </button>
        )}
      </div>
    </div>
  );
};

const RouteOptimizerCard = ({ routeData, routeLoading, selectedRouteId, onSelectRoute }: Props) => {
  const [showAlternates, setShowAlternates] = useState(false);

  if (routeLoading) {
    return (
      <div className="mt-6 bg-card/60 backdrop-blur-xl border border-border/50 rounded-xl p-5">
        <div className="py-10 flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <div className="text-center">
            <p className="text-foreground font-medium text-sm">Optimizing route — A* pathfinding in progress...</p>
            <p className="text-muted-foreground text-xs font-mono mt-1">
              Analyzing weather nodes · traffic conflicts · historical patterns
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!routeData) return null;

  const { primary_route, alternate_routes, conflict_details, weather_conditions, weather_risk, historical_suggestion } = routeData;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mt-6 bg-card/60 backdrop-blur-xl border border-border/50 rounded-xl p-5 space-y-6"
    >
      {/* ── Section 1: Primary Route ── */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-xs font-mono tracking-widest uppercase text-primary">AI Optimized Route</span>
        </div>

        <div className="flex items-start gap-5">
          {/* Score ring */}
          <div
            className={`w-16 h-16 rounded-full border-4 flex items-center justify-center shrink-0 font-mono font-bold text-xl ${scoreRingColor(primary_route.overall_score)}`}
          >
            {primary_route.overall_score}
          </div>

          <div className="flex-1 space-y-2">
            <RouteScoreBar label="Safety" score={primary_route.safety_score} />
            <RouteScoreBar label="Weather" score={primary_route.weather_score} />
            <RouteScoreBar label="Traffic" score={primary_route.traffic_score} />
            <RouteScoreBar label="Efficiency" score={primary_route.efficiency_score} />
          </div>
        </div>

        {primary_route.selection_reason && (
          <p className="text-xs text-muted-foreground italic mt-3 leading-relaxed">
            {primary_route.selection_reason}
          </p>
        )}

        <div className="flex items-center gap-4 mt-3 text-xs font-mono text-muted-foreground">
          <span>
            <span className="text-foreground font-semibold">{primary_route.distance_km} km</span> total distance
          </span>
          <span>·</span>
          <span>
            <span className="text-foreground font-semibold">{primary_route.estimated_time_min} min</span> est. flight time
          </span>
        </div>
      </div>

      {/* ── Section 2: Alternate Routes ── */}
      {alternate_routes && alternate_routes.length > 0 && (
        <div>
          <button
            onClick={() => setShowAlternates((v) => !v)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
          >
            {showAlternates ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {showAlternates ? "Hide" : "Show"} {alternate_routes.length} alternate route{alternate_routes.length !== 1 ? "s" : ""}
          </button>

          <AnimatePresence>
            {showAlternates && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden space-y-3"
              >
                {alternate_routes.map((route) => (
                  <AlternateCard
                    key={route.id}
                    route={route}
                    selected={selectedRouteId === route.id}
                    onSelect={() => onSelectRoute?.(route.id)}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ── Section 3: Intelligence Panel ── */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Conflict Summary */}
        <div className="bg-secondary/50 rounded-lg p-4">
          <p className="text-xs font-mono tracking-widest uppercase text-muted-foreground mb-3">
            Conflict Summary
          </p>
          {conflict_details.length === 0 ? (
            <div className="flex items-center gap-2 text-green-400">
              <CheckCircle className="w-4 h-4" />
              <span className="text-sm">Airspace clear</span>
            </div>
          ) : (
            <div className="space-y-2">
              {conflict_details.map((c, i) => (
                <div key={i} className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-foreground">{c.aircraft_id}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${severityBadge(c.severity)}`}>
                        {c.severity}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{c.conflict_type}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Historical Pattern */}
        <div className="bg-secondary/50 rounded-lg p-4">
          <p className="text-xs font-mono tracking-widest uppercase text-muted-foreground mb-3">
            Historical Pattern
          </p>
          {historical_suggestion.found ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 font-mono">
                  Route suggestion available
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{historical_suggestion.message}</p>
              <div className="flex items-center gap-4 text-xs font-mono">
                <span className="text-muted-foreground">
                  Flights: <span className="text-foreground">{historical_suggestion.flight_count}</span>
                </span>
                <span className="text-muted-foreground">
                  Avg score: <span className="text-primary">{historical_suggestion.avg_score}</span>
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No historical data for this route pair.</p>
          )}
        </div>
      </div>

      {/* Weather Stats */}
      <div>
        <p className="text-xs font-mono tracking-widest uppercase text-muted-foreground mb-3">
          Weather Conditions
          <span
            className={`ml-2 px-2 py-0.5 rounded-full text-[10px] font-mono ${
              weather_risk === "low"
                ? "bg-green-500/20 text-green-400"
                : weather_risk === "moderate"
                ? "bg-yellow-500/20 text-yellow-400"
                : weather_risk === "high"
                ? "bg-red-500/20 text-red-400"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {weather_risk}
          </span>
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-secondary/50 rounded-lg p-3 flex items-center gap-2">
            <Wind className="w-4 h-4 text-primary shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground">Wind</p>
              <p className="text-sm font-mono font-bold">{weather_conditions.wind_speed} km/h</p>
            </div>
          </div>
          <div className="bg-secondary/50 rounded-lg p-3 flex items-center gap-2">
            <Wind className="w-4 h-4 text-accent shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground">Gusts</p>
              <p className="text-sm font-mono font-bold">{weather_conditions.wind_gusts} km/h</p>
            </div>
          </div>
          <div className="bg-secondary/50 rounded-lg p-3 flex items-center gap-2">
            <CloudRain className="w-4 h-4 text-blue-400 shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground">Precip</p>
              <p className="text-sm font-mono font-bold">{weather_conditions.precipitation} mm</p>
            </div>
          </div>
          <div className="bg-secondary/50 rounded-lg p-3 flex items-center gap-2">
            <Thermometer className="w-4 h-4 text-orange-400 shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground">Temp</p>
              <p className="text-sm font-mono font-bold">{weather_conditions.temperature}°C</p>
            </div>
          </div>
        </div>
      </div>

      {/* Analysis summary footer */}
      <div className="border-t border-border/30 pt-3 text-[11px] text-muted-foreground font-mono">
        <span className="text-primary/70">Method:</span>{" "}
        {routeData.analysis_summary.optimization_method} · {routeData.analysis_summary.routes_evaluated} routes evaluated
      </div>
    </motion.div>
  );
};

export default RouteOptimizerCard;
