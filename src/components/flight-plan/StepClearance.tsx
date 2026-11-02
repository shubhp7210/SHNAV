import { lazy, Suspense } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Circle } from "lucide-react";
import type { FlightPlanData } from "@/pages/FlightPlan";
import RouteOptimizerCard from "@/components/route/RouteOptimizerCard";
import FlightDecisionPanel from "@/components/atm/FlightDecisionPanel";
import WeatherIntelligenceCard from "@/components/atm/WeatherIntelligenceCard";
import AirspaceSchedulePanel from "@/components/atm/AirspaceSchedulePanel";
import VertiportStatusCard from "@/components/atm/VertiportStatusCard";
import TrajectoryConflictAlert from "@/components/atm/TrajectoryConflictAlert";
import MapLoading from "@/components/MapLoading";

// The preview map pulls in the map stack; keep it off the step's critical path.
const RoutePreviewMap = lazy(() => import("@/components/flight-plan/RoutePreviewMap"));

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
  onSelectRoute?: (routeId: string) => void | Promise<void>;
  /** Re-run the full analysis pipeline (after a failure). */
  onRetry?: () => void;
}

const ENGINE_LABEL: Record<string, string> = {
  "weather-intelligence": "Weather",
  "airspace-scheduler": "Airspace scheduler",
  "vertiport-coordinator": "Vertiport coordinator",
  "trajectory-predictor": "Trajectory predictor",
};

/** "fn: message | fn: message" → readable engine names (messages stay in console). */
function failedEngines(atmError: string | null): string[] {
  if (!atmError) return [];
  return atmError.split(" | ").map((part) => {
    const fn = part.split(":")[0].trim();
    return ENGINE_LABEL[fn] ?? "Decision pipeline";
  });
}

type StageState = "done" | "running" | "pending";
function Stage({ label, detail, state }: { label: string; detail: string; state: StageState }) {
  return (
    <li className="flex items-start gap-3 py-3">
      {state === "done" ? <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
        : state === "running" ? <Loader2 className="w-4 h-4 text-signal animate-spin mt-0.5 shrink-0" />
        : <Circle className="w-4 h-4 text-muted-foreground/50 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <p className={`text-sm font-medium ${state === "pending" ? "text-muted-foreground" : "text-foreground"}`}>{label}</p>
        <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{detail}</p>
      </div>
    </li>
  );
}

const StepClearance = ({ data, onSelectRoute, onRetry }: Props) => {
  const { atmEngines } = data;
  const loading = data.analysisLoading || data.routeLoading || atmEngines.atmLoading;
  const failed = !loading && !data.analysisComplete;
  const failures = failedEngines(atmEngines.atmError);

  const trajState: StageState = data.analysisComplete ? "done" : data.analysisLoading ? "running" : "pending";
  // routeLoading is raised together with analysisLoading, but the optimizer only
  // starts once trajectory analysis has finished.
  const routeState: StageState = data.analysisLoading ? "pending" : data.routeLoading ? "running" : data.analysisComplete ? "done" : "pending";
  const atmState: StageState = atmEngines.atmLoading ? "running" : atmEngines.flightDecision ? "done" : "pending";

  return (
    <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] gap-5 items-start">
      {/* 3D route preview — sticky on desktop */}
      <div className="relative rounded-2xl overflow-hidden border border-border h-[48vh] min-h-[320px] lg:h-[calc(100dvh-14.5rem)] lg:sticky lg:top-[5.5rem] bg-card">
        <Suspense fallback={<MapLoading />}>
          <RoutePreviewMap data={data} />
        </Suspense>
      </div>

      <div className="space-y-4 min-w-0">
        {loading && (
          <section className="panel rounded-2xl p-5" aria-live="polite">
            <p className="label-caps mb-1">Clearance analysis</p>
            <p className="font-display text-lg font-semibold">Running ATM engines…</p>
            <ol className="mt-3 divide-y divide-border">
              <Stage label="Trajectory analysis" detail="Conflict + score against filed traffic" state={trajState} />
              <Stage label="Route optimization" detail="A* corridors · weather nodes · historical patterns" state={routeState} />
              <Stage label="ATM engines + decision" detail="Weather · airspace · vertiports · prediction → decision" state={atmState} />
            </ol>
          </section>
        )}

        {failed && (
          <section className="panel rounded-2xl p-5 border-destructive/40" role="alert">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold">Analysis did not complete</p>
                <p className="text-sm text-muted-foreground mt-1">
                  The trajectory service didn't return a result, so no clearance can be issued yet. Check the
                  connection and try again — your flight intent is unchanged.
                </p>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:brightness-110 transition"
                  >
                    <RotateCcw className="w-4 h-4" /> Retry analysis
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {!loading && failures.length > 0 && (
          <div className="rounded-xl border border-caution/40 bg-caution/10 px-4 py-3 flex items-start gap-2.5" role="status">
            <AlertTriangle className="w-4 h-4 text-caution shrink-0 mt-0.5" />
            <p className="text-xs text-foreground/85 leading-relaxed">
              <span className="font-semibold">Partial analysis.</span> {failures.join(", ")} did not respond — the decision
              below was made without {failures.length === 1 ? "it" : "them"}. Treat it with extra caution.
            </p>
          </div>
        )}

        {!loading && (
          <>
            {atmEngines.flightDecision && <FlightDecisionPanel decision={atmEngines.flightDecision} />}
            {atmEngines.trajectoryPredict && <TrajectoryConflictAlert data={atmEngines.trajectoryPredict} />}
            {atmEngines.weatherIntel && <WeatherIntelligenceCard weather={atmEngines.weatherIntel} />}
            {(atmEngines.airspaceSchedule || atmEngines.vertiportStatus) && (
              <div className={`grid grid-cols-1 gap-4 ${atmEngines.airspaceSchedule && atmEngines.vertiportStatus ? "xl:grid-cols-2" : ""}`}>
                {atmEngines.airspaceSchedule && <AirspaceSchedulePanel schedule={atmEngines.airspaceSchedule} />}
                {atmEngines.vertiportStatus && <VertiportStatusCard status={atmEngines.vertiportStatus} />}
              </div>
            )}
            <RouteOptimizerCard
              routeData={data.routeData}
              routeLoading={data.routeLoading}
              selectedRouteId={data.selectedRouteId}
              onSelectRoute={onSelectRoute}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default StepClearance;
