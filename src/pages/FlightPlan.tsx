import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { reportClientError } from "@/lib/errorReporter";
import { localDateISO, localInstant } from "@/lib/time";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  UserCheck,
  Send,
  GitBranch,
  Shield,
  ArrowLeft,
  ArrowRight,
  Check,
} from "lucide-react";
import Logo from "@/components/Logo";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import type { RouteOptimizerResult } from "@/lib/routeTypes";
import type { ATMEngineState, WeatherIntelligenceResult, AirspaceScheduleResult, VertiportStatusResult, TrajectoryPredictorResult, FlightDecisionResult } from "@/lib/atmTypes";
import StepRegistration from "@/components/flight-plan/StepRegistration";
import StepIntent from "@/components/flight-plan/StepIntent";
import StepClearance from "@/components/flight-plan/StepClearance";
// StepMonitoring carries the live 3D view and audio engine — lazy-load so initial
// routes stay light, especially on mobile where the user may never reach this step.
const StepMonitoring = lazy(() => import("@/components/flight-plan/StepMonitoring"));

// Authority Review step removed — the decision engine produces a single
// authoritative GO/DELAY/REROUTE outcome, so an extra acknowledgment
// checkbox added latency without operational value.
const steps = [
  { title: "Registration", icon: UserCheck, description: "Vehicle & Operator Registration" },
  { title: "Flight Intent", icon: Send, description: "Flight Intent Submission" },
  { title: "Clearances", icon: GitBranch, description: "Departure Clearance" },
  { title: "Monitoring", icon: Shield, description: "In-Flight Monitoring" },
];

export interface FlightPlanData {
  aircraftId: string;
  operatorName: string;
  aircraftType: string;
  origin: string;
  destination: string;
  altitudeBand: string;
  departureWindowStart: string;
  departureWindowEnd: string;
  departureDate: string; // YYYY-MM-DD — full date for future scheduling
  conflicts: number;
  trajectoryScore: number;
  weatherRisk: string;
  selectedClearance: string;
  bestDepartureTime: string;
  authorityApproved: boolean;
  monitoringActive: boolean;
  analysisComplete: boolean;
  analysisLoading: boolean;
  routeData: RouteOptimizerResult | null;
  routeLoading: boolean;
  selectedRouteId: string | null;
  // ATM Engine
  atmEngines: ATMEngineState;
  flightIntentId: string | null;
}

const initialATMState: ATMEngineState = {
  weatherIntel: null,
  airspaceSchedule: null,
  vertiportStatus: null,
  trajectoryPredict: null,
  flightDecision: null,
  atmLoading: false,
  atmError: null,
};

const initialData: FlightPlanData = {
  aircraftId: "",
  operatorName: "",
  aircraftType: "evtol",
  origin: "",
  destination: "",
  altitudeBand: "low",
  departureWindowStart: "",
  departureWindowEnd: "",
  departureDate: localDateISO(),
  conflicts: 0,
  trajectoryScore: 0,
  weatherRisk: "low",
  selectedClearance: "",
  bestDepartureTime: "",
  authorityApproved: false,
  monitoringActive: false,
  analysisComplete: false,
  analysisLoading: false,
  routeData: null,
  routeLoading: false,
  selectedRouteId: null,
  atmEngines: initialATMState,
  flightIntentId: null,
};

function validateStep(step: number, data: FlightPlanData): string | null {
  switch (step) {
    case 0:
      if (!data.aircraftId.trim()) return "Aircraft Registration ID is required.";
      if (!data.operatorName.trim()) return "Operator Name is required.";
      return null;
    case 1: {
      if (!data.origin.trim()) return "Origin is required.";
      if (!data.destination.trim()) return "Destination is required.";
      if (!data.departureWindowStart) return "Departure window start is required.";
      if (!data.departureWindowEnd) return "Departure window end is required.";
      // Validate 10 min max
      const s = toMinutes(data.departureWindowStart);
      const e = toMinutes(data.departureWindowEnd);
      if (e <= s) return "End time must be after start time.";
      if (e - s > 10) return "Departure window cannot exceed 10 minutes.";
      const startAt = new Date(`${data.departureDate}T${data.departureWindowStart}:00`).getTime();
      if (startAt < Date.now() - 15 * 60_000) return "Departure window is in the past.";
      if (startAt > Date.now() + 14 * 86_400_000) return "Departure must be within 14 days (weather forecast horizon).";
      return null;
    }
    case 2:
      if (data.analysisLoading || data.routeLoading || data.atmEngines.atmLoading) return "Analysis is still processing...";
      if (!data.analysisComplete) return "Analysis did not complete — use Retry analysis on this step.";
      return null;
    default:
      return null;
  }
}

/** Best human-readable message from a supabase.functions.invoke error. */
async function functionErrorMessage(error: { message: string; context?: unknown }): Promise<string> {
  const ctx = error.context as Response | undefined;
  try {
    if (ctx && typeof ctx.json === "function") {
      const body = await ctx.clone().json();
      if (body?.details?.length) return `${body.error}: ${body.details.join("; ")}`;
      if (body?.error) return String(body.error);
    }
  } catch { /* fall through */ }
  return error.message;
}

/** Location string without its "@ lat,lon" geocode tag. */
const placeLabel = (loc: string) => (loc ?? "").replace(/\s*@\s*-?\d+\.?\d*\s*,\s*-?\d+\.?\d*\s*$/, "") || "—";

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function getSettledFunctionData<T>(
  functionName: string,
  result: PromiseSettledResult<{ data: T | null; error: { message?: string } | null }>,
  errors: string[]
): T | null {
  if (result.status === "rejected") {
    const message = `${functionName}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
    console.error(`[ATM] ${message}`);
    errors.push(message);
    return null;
  }

  if (result.value.error) {
    const message = `${functionName}: ${result.value.error.message ?? "Unknown function error"}`;
    console.error(`[ATM] ${message}`);
    errors.push(message);
    return null;
  }

  return result.value.data;
}

const FlightPlan = () => {
  const { user } = useAuth();
  const isLoggedIn = !!user;
  const [searchParams] = useSearchParams();
  const testMap = searchParams.get("test") === "map";

  // If ?test=map, jump straight to monitoring with dummy data
  // Steps: 0=Registration, 1=Intent, 2=Clearance, 3=Monitoring (Authority removed)
  const [currentStep, setCurrentStep] = useState(testMap ? 3 : isLoggedIn ? 1 : 0);
  const [data, setData] = useState<FlightPlanData>(() => ({
    ...initialData,
    aircraftId: user?.user_metadata?.aircraft_id ?? (testMap ? "TEST-001" : ""),
    operatorName: user?.user_metadata?.operator_name ?? (user?.email?.split("@")[0] ?? (testMap ? "Test Pilot" : "")),
    ...(testMap ? {
      origin: "New York",
      destination: "Boston",
      altitudeBand: "mid",
      departureWindowStart: "10:00",
      departureWindowEnd: "10:10",
      monitoringActive: true,
      analysisComplete: true,
      authorityApproved: true,
      selectedClearance: "auto-best",
    } : {}),
  }));
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(
    testMap ? new Set([0, 1, 2, 3]) : isLoggedIn ? new Set([0]) : new Set()
  );
  const navigate = useNavigate();
  const { toast } = useToast();

  const updateData = (partial: Partial<FlightPlanData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  };

  // Idempotency key for the current flight intent; a new key whenever any
  // field that defines the intent changes (that's a genuinely new filing).
  const idemKeyRef = useRef<string | null>(null);
  useEffect(() => {
    idemKeyRef.current = null;
  }, [data.aircraftId, data.aircraftType, data.origin, data.destination, data.altitudeBand, data.departureDate, data.departureWindowStart, data.departureWindowEnd]);

  const runATMEngines = async (intentId: string | null, tScore: number, wRisk: string, cCount: number, rData: RouteOptimizerResult | null) => {
    console.info("[ATM] starting decision pipeline", { intentId, hasRouteData: !!rData });
    updateData({ atmEngines: { ...initialATMState, atmLoading: true } });
    // Shown when no server decision exists. Never a GO: a clearance can only
    // come from the server, which evaluates stored, verified inputs.
    const noDecision = (why: string): FlightDecisionResult => ({
      decision_id: null, decision: "DELAY", reason: why, confidence: 0,
      departure_time: data.departureDate && data.departureWindowStart ? localInstant(data.departureDate, data.departureWindowStart) : new Date().toISOString(),
      delay_minutes: 0, route_id: rData?.primary_route?.id ?? null,
      simulation: { safe: false, predicted_conflicts: cCount, weather_at_arrival: "unknown", energy_adequate: false, airspace_clear: false },
      inputs_summary: { trajectory_score: tScore, weather_risk: wRisk, weather_risk_score: null, conflicts: cCount, airspace_load: null, vertiport_delay: null, route_score: rData?.primary_route?.overall_score ?? null, forecast_trend: "unknown" },
    });
    if (!intentId) {
      updateData({ atmEngines: { ...initialATMState, flightDecision: noDecision("No flight intent on file — analysis must complete before a decision can be made."), atmLoading: false } });
      return;
    }
    try {
      // Engines read the stored intent server-side; only its id is sent.
      const [weatherRes, airspaceRes, vertiportRes, trajectoryRes] = await Promise.allSettled([
        supabase.functions.invoke("weather-intelligence", { body: { flight_intent_id: intentId } }),
        supabase.functions.invoke("airspace-scheduler", { body: { flight_intent_id: intentId } }),
        supabase.functions.invoke("vertiport-coordinator", { body: { flight_intent_id: intentId } }),
        supabase.functions.invoke("trajectory-predictor", { body: { flight_intent_id: intentId } }),
      ]);

      const nonBlockingErrors: string[] = [];
      const weatherIntel = getSettledFunctionData<WeatherIntelligenceResult>("weather-intelligence", weatherRes, nonBlockingErrors);
      const airspaceSchedule = getSettledFunctionData<AirspaceScheduleResult>("airspace-scheduler", airspaceRes, nonBlockingErrors);
      const vertiportStatus = getSettledFunctionData<VertiportStatusResult>("vertiport-coordinator", vertiportRes, nonBlockingErrors);
      const trajectoryPredict = getSettledFunctionData<TrajectoryPredictorResult>("trajectory-predictor", trajectoryRes, nonBlockingErrors);

      const { data: decisionRes, error: decisionError } = await supabase.functions.invoke("flight-decision-engine", {
        body: { flight_intent_id: intentId, selected_candidate_id: rData?.primary_route?.id },
      });
      if (decisionError) nonBlockingErrors.push(`flight-decision-engine: ${decisionError.message}`);
      const flightDecision: FlightDecisionResult = (decisionRes as FlightDecisionResult)?.decision
        ? (decisionRes as FlightDecisionResult)
        : noDecision("The decision engine did not respond — no clearance has been issued. Retry analysis.");

      console.info("[ATM] decision pipeline complete", { intentId, decision: flightDecision.decision, confidence: flightDecision.confidence });

      const clearanceMap = { GO: "auto-best", DELAY: "delayed-departure", REROUTE: "alternate-corridor" };
      updateData({
        selectedClearance: clearanceMap[flightDecision.decision] ?? "auto-best",
        selectedRouteId: flightDecision.route_id ?? rData?.primary_route?.id ?? null,
        atmEngines: {
          weatherIntel, airspaceSchedule, vertiportStatus, trajectoryPredict, flightDecision,
          atmLoading: false,
          atmError: nonBlockingErrors.length > 0 ? nonBlockingErrors.join(" | ") : null,
        },
      });
    } catch (e: unknown) {
      console.error("ATM engines failed:", e);
      reportClientError(e, "manual");
      updateData({
        atmEngines: { ...initialATMState, flightDecision: noDecision("Live analysis is unavailable — no clearance has been issued. Retry analysis."), atmLoading: false, atmError: e instanceof Error ? e.message : "unknown" },
      });
    }
  };

  // Re-run decision engine when user picks a different alternate route
  const applyRouteSelection = async (routeId: string) => {
    if (!data.routeData) return;
    if (routeId === data.selectedRouteId) return;
    const all = [data.routeData.primary_route, ...data.routeData.alternate_routes];
    const chosen = all.find((r) => r.id === routeId);
    if (!chosen) return;
    // Swap chosen to primary in a synthetic routeData and re-run engine
    const swapped: RouteOptimizerResult = {
      ...data.routeData,
      primary_route: chosen,
      alternate_routes: all.filter((r) => r.id !== routeId),
    };
    updateData({ routeData: swapped, selectedRouteId: routeId });
    await runATMEngines(data.flightIntentId, data.trajectoryScore, data.weatherRisk, data.conflicts, swapped);
  };

  // Full clearance pipeline: trajectory analysis → route optimizer → ATM engines.
  // Called when leaving the Intent step, and from "Retry analysis" on failure.
  const runAnalysis = async () => {
    updateData({ analysisLoading: true, analysisComplete: false, routeLoading: true });
    let tScore = 80, wRisk = "low", cCount = 0, intentId: string | null = null;
    // Same key for retries / double submits of the same intent → the server
    // returns the existing filing instead of creating phantom duplicate traffic.
    idemKeyRef.current ??= crypto.randomUUID();
    try {
      const { data: response, error } = await supabase.functions.invoke("trajectory-analysis", {
        body: {
          aircraft_id: data.aircraftId,
          operator_name: data.operatorName,
          aircraft_type: data.aircraftType,
          origin: data.origin,
          destination: data.destination,
          altitude_band: data.altitudeBand,
          departure_window_start: data.departureWindowStart,
          departure_window_end: data.departureWindowEnd,
          // Absolute instants with offset — the server never guesses a timezone.
          departure_start_at: localInstant(data.departureDate, data.departureWindowStart),
          departure_end_at: localInstant(data.departureDate, data.departureWindowEnd),
          idempotency_key: idemKeyRef.current,
        },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      if (!response?.intent_id) throw new Error("trajectory-analysis did not return an intent ID");
      tScore = response.trajectory_score;
      wRisk = response.weather_risk;
      cCount = response.conflicts;
      intentId = response.intent_id ?? null;

      console.info("[ATM] trajectory analysis complete", {
        intentId,
        trajectoryScore: tScore,
        weatherRisk: wRisk,
        conflicts: cCount,
      });

      const s = toMinutes(data.departureWindowStart);
      const bestMin = s + Math.floor((toMinutes(data.departureWindowEnd) - s) / 2);
      const bestH = String(Math.floor(bestMin / 60)).padStart(2, "0");
      const bestM = String(bestMin % 60).padStart(2, "0");

      updateData({
        conflicts: cCount,
        trajectoryScore: tScore,
        weatherRisk: wRisk,
        bestDepartureTime: `${bestH}:${bestM}`,
        analysisComplete: true,
        analysisLoading: false,
        flightIntentId: intentId,
        selectedClearance: tScore > 80 ? "auto-best" : "",
      });
    } catch (e: unknown) {
      toast({ title: "Analysis failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
      updateData({ analysisLoading: false, routeLoading: false });
      return;
    }

    // Run route optimizer and ATM engines in parallel
    const [routeResult] = await Promise.allSettled([
      supabase.functions.invoke("route-optimizer", { body: { flight_intent_id: intentId } }),
    ]);

    let rData: RouteOptimizerResult | null = null;
    if (routeResult.status === "fulfilled" && !routeResult.value.error) {
      rData = routeResult.value.data as RouteOptimizerResult;
      console.info("[ATM] route optimization complete", {
        intentId,
        routeId: rData?.route_id,
        overallScore: rData?.primary_route?.overall_score,
        waypointCount: rData?.primary_route?.waypoints?.length,
      });
    } else if (routeResult.status === "fulfilled" && routeResult.value.error) {
      console.error("[ATM] route-optimizer failed", routeResult.value.error.message);
    } else if (routeResult.status === "rejected") {
      console.error("[ATM] route-optimizer failed", routeResult.reason);
    }

    updateData({ routeData: rData, routeLoading: false });

    await runATMEngines(intentId, tScore, wRisk, cCount, rData);
  };

  const completeStep = () => {
    const err = validateStep(currentStep, data);
    if (err) {
      toast({ title: "Complete this step", description: err, variant: "destructive" });
      return;
    }
    setCompletedSteps((prev) => new Set([...prev, currentStep]));

    // Route-pattern learning happens server-side (route-optimizer upserts
    // patterns; record-flight-outcome adjusts them on landing). Client-side
    // writes to route_patterns are blocked by RLS.

    // Trigger all engines when leaving Intent step
    if (currentStep === 1) void runAnalysis();

    if (currentStep < steps.length - 1) setCurrentStep(currentStep + 1);
  };

  const goBack = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  const monitoringFallback = (
    <div className="py-16 flex flex-col items-center gap-3 text-center">
      <span className="w-8 h-8 rounded-full border-2 border-border border-t-signal animate-spin" />
      <p className="text-sm text-muted-foreground font-mono">Loading 3D tracking…</p>
    </div>
  );
  const stepComponents = [
    <StepRegistration data={data} updateData={updateData} />,
    <StepIntent data={data} updateData={updateData} />,
    <StepClearance data={data} updateData={updateData} onSelectRoute={applyRouteSelection} onRetry={() => void runAnalysis()} />,
    <Suspense fallback={monitoringFallback}>
      <StepMonitoring data={data} updateData={updateData} />
    </Suspense>,
  ];

  // Hide the Registration step from the stepper when the user is signed in
  // (it's auto-prefilled from their profile, so it adds visual noise).
  const visibleSteps = steps
    .map((s, i) => ({ ...s, idx: i }))
    .filter((s) => !(s.idx === 0 && isLoggedIn));
  const visibleStepCount = visibleSteps.length;
  const visiblePosition = visibleSteps.findIndex((s) => s.idx === currentStep) + 1;
  // Form steps read best narrow; the map-led steps use the full width.
  const wide = currentStep >= 2;
  const busy = data.analysisLoading || data.routeLoading || data.atmEngines.atmLoading;

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex items-center gap-3 h-14 sm:h-16 px-3 sm:px-6">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-2 min-h-[40px] px-2 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors shrink-0"
            aria-label="Back to home"
          >
            <ArrowLeft className="w-4 h-4" />
            <Logo size={24} compact showWordmark={false} />
            <span className="hidden md:inline font-display font-semibold text-sm text-foreground">Flight planner</span>
          </button>

          {/* Stepper */}
          <nav className="flex-1 min-w-0 flex justify-center" aria-label="Flight plan steps">
            <ol className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {visibleSteps.map(({ idx, title, icon: Icon }, i) => {
                const isActive = idx === currentStep;
                const isCompleted = completedSteps.has(idx);
                const canJump = isCompleted || idx <= currentStep;
                return (
                  <li key={title} className="flex items-center shrink-0">
                    <button
                      onClick={() => canJump && setCurrentStep(idx)}
                      aria-current={isActive ? "step" : undefined}
                      aria-label={`Step ${i + 1} of ${visibleStepCount}: ${title}${isCompleted ? " (completed)" : ""}`}
                      disabled={!canJump}
                      className={`flex items-center gap-2 h-9 pl-1 pr-1 sm:pr-3 rounded-full transition-colors ${
                        isActive ? "bg-white/10" : canJump ? "hover:bg-white/5" : "opacity-40 cursor-not-allowed"
                      }`}
                    >
                      <span
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                          isActive
                            ? "bg-primary text-primary-foreground glow-primary"
                            : isCompleted
                            ? "bg-primary/15 text-primary border border-primary/40"
                            : "bg-secondary text-muted-foreground"
                        }`}
                      >
                        {isCompleted && !isActive ? <Check className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
                      </span>
                      <span className={`hidden sm:inline text-xs font-medium whitespace-nowrap ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                        {title}
                      </span>
                    </button>
                    {i < visibleStepCount - 1 && (
                      <span className={`w-3 sm:w-6 h-px mx-0.5 ${isCompleted ? "bg-primary/50" : "bg-border"}`} aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <span className="hidden lg:inline font-mono text-[11px] text-muted-foreground tabular shrink-0">
            {data.aircraftId || "—"}
          </span>
        </div>
      </header>

      {/* Bottom padding leaves room for the sticky action bar + mobile tab bar. */}
      <main
        className={`w-full mx-auto px-4 sm:px-6 py-5 sm:py-8 flex-1 ${wide ? "max-w-7xl" : "max-w-3xl"}`}
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 9rem)" }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mb-5 sm:mb-7 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="label-caps text-primary/90">
                  Step {visiblePosition} of {visibleStepCount} · {steps[currentStep].title}
                </p>
                <h1 className="text-2xl sm:text-3xl md:text-[2.5rem] font-semibold mt-2 leading-tight">
                  {steps[currentStep].description}
                </h1>
              </div>
              {wide && (data.origin || data.destination) && (
                <p className="font-mono text-xs text-muted-foreground flex items-center gap-2 min-w-0">
                  <span className="truncate max-w-[40vw] sm:max-w-[260px] text-foreground/80">{placeLabel(data.origin)}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="truncate max-w-[40vw] sm:max-w-[260px] text-foreground/80">{placeLabel(data.destination)}</span>
                </p>
              )}
            </div>

            {wide ? (
              stepComponents[currentStep]
            ) : (
              <div className="panel rounded-2xl p-5 sm:p-7 md:p-8">{stepComponents[currentStep]}</div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Sticky action bar — sits above the mobile tab bar. */}
      <div className="fixed inset-x-0 bottom-[calc(52px+env(safe-area-inset-bottom,0px))] md:bottom-0 z-30 border-t border-border bg-background/85 backdrop-blur-xl">
        <div className={`mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3 ${wide ? "max-w-7xl" : "max-w-3xl"}`}>
          <button
            onClick={goBack}
            disabled={currentStep === 0 || (isLoggedIn && currentStep === 1)}
            className="flex items-center gap-2 px-4 sm:px-5 h-11 rounded-lg border border-border text-foreground disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white/5 transition-colors text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Previous</span>
            <span className="sm:hidden">Back</span>
          </button>
          {busy && (
            <span className="hidden sm:flex items-center gap-2 text-xs font-mono text-muted-foreground">
              <span className="w-3 h-3 rounded-full border-2 border-border border-t-signal animate-spin" /> Analysis running
            </span>
          )}
          <button
            onClick={completeStep}
            disabled={busy}
            className="flex items-center gap-2 px-5 sm:px-6 h-11 rounded-lg bg-primary text-primary-foreground hover:brightness-110 transition font-semibold disabled:opacity-50 text-sm"
          >
            {currentStep === steps.length - 1 ? (
              completedSteps.has(steps.length - 1) ? "Mission active ✓" : "Activate monitoring"
            ) : currentStep === 1 ? (
              <>Run clearance <ArrowRight className="w-4 h-4" /></>
            ) : currentStep === 2 ? (
              <>Proceed to monitoring <ArrowRight className="w-4 h-4" /></>
            ) : (
              <>Continue <ArrowRight className="w-4 h-4" /></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FlightPlan;
