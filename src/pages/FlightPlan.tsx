import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  UserCheck,
  Send,
  GitBranch,
  Eye,
  Shield,
  ArrowLeft,
  ArrowRight,
  Check,
  Plane,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import type { RouteOptimizerResult } from "@/lib/routeTypes";
import type { ATMEngineState, WeatherIntelligenceResult, AirspaceScheduleResult, VertiportStatusResult, TrajectoryPredictorResult, FlightDecisionResult } from "@/lib/atmTypes";
import StepRegistration from "@/components/flight-plan/StepRegistration";
import StepIntent from "@/components/flight-plan/StepIntent";
import StepClearance from "@/components/flight-plan/StepClearance";
import StepAuthority from "@/components/flight-plan/StepAuthority";
import StepMonitoring from "@/components/flight-plan/StepMonitoring";

const steps = [
  { title: "Registration", icon: UserCheck, description: "Vehicle & Operator Registration" },
  { title: "Flight Intent", icon: Send, description: "Flight Intent Submission" },
  { title: "Clearances", icon: GitBranch, description: "Departure Clearance" },
  { title: "Authority", icon: Eye, description: "Authority Review" },
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
  departureDate: new Date().toISOString().split("T")[0],
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
      return null;
    }
    case 2:
      if (!data.analysisComplete || data.atmEngines.atmLoading) return "Analysis is still processing...";
      return null;
    case 3:
      if (!data.authorityApproved) return "Authority acknowledgment is required.";
      return null;
    default:
      return null;
  }
}

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
  const [currentStep, setCurrentStep] = useState(testMap ? 4 : isLoggedIn ? 1 : 0);
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
    testMap ? new Set([0, 1, 2, 3, 4]) : isLoggedIn ? new Set([0]) : new Set()
  );
  const navigate = useNavigate();
  const { toast } = useToast();

  const updateData = (partial: Partial<FlightPlanData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  };

  const runATMEngines = async (intentId: string | null, tScore: number, wRisk: string, cCount: number, rData: RouteOptimizerResult | null) => {
    console.info("[ATM] starting decision pipeline", {
      intentId,
      aircraftId: data.aircraftId,
      origin: data.origin,
      destination: data.destination,
      trajectoryScore: tScore,
      weatherRisk: wRisk,
      conflicts: cCount,
      hasRouteData: !!rData,
    });
    updateData({ atmEngines: { ...initialATMState, atmLoading: true } });
    try {
      const depStart = data.departureWindowStart
        ? `${new Date().toISOString().split("T")[0]}T${data.departureWindowStart}:00`
        : new Date().toISOString();

      // Run weather, airspace, vertiport, trajectory in parallel
      const [weatherRes, airspaceRes, vertiportRes, trajectoryRes] = await Promise.allSettled([
        supabase.functions.invoke("weather-intelligence", {
          body: { origin: data.origin, destination: data.destination, altitude_band: data.altitudeBand },
        }),
        supabase.functions.invoke("airspace-scheduler", {
          body: {
            flight_intent_id: intentId,
            aircraft_id: data.aircraftId,
            aircraft_type: data.aircraftType,
            altitude_band: data.altitudeBand,
            origin: data.origin,
            destination: data.destination,
            departure_window_start: depStart,
            departure_window_end: `${new Date().toISOString().split("T")[0]}T${data.departureWindowEnd}:00`,
          },
        }),
        supabase.functions.invoke("vertiport-coordinator", {
          body: {
            flight_intent_id: intentId,
            aircraft_id: data.aircraftId,
            origin: data.origin,
            destination: data.destination,
            departure_time: depStart,
          },
        }),
        supabase.functions.invoke("trajectory-predictor", {
          body: { flight_intent_id: intentId },
        }),
      ]);

      const nonBlockingErrors: string[] = [];

      const weatherIntel = getSettledFunctionData<WeatherIntelligenceResult>("weather-intelligence", weatherRes, nonBlockingErrors);
      const airspaceSchedule = getSettledFunctionData<AirspaceScheduleResult>("airspace-scheduler", airspaceRes, nonBlockingErrors);
      const vertiportStatus = getSettledFunctionData<VertiportStatusResult>("vertiport-coordinator", vertiportRes, nonBlockingErrors);
      const trajectoryPredict = getSettledFunctionData<TrajectoryPredictorResult>("trajectory-predictor", trajectoryRes, nonBlockingErrors);

      // Now run the decision engine with all data
      const { data: decisionRes, error: decisionError } = await supabase.functions.invoke("flight-decision-engine", {
        body: {
          flight_intent_id: intentId,
          aircraft_id: data.aircraftId,
          operator_name: data.operatorName,
          trajectory_score: tScore,
          weather_risk: wRisk,
          conflicts: cCount,
          route_data: rData,
          weather_intel: weatherIntel,
          airspace_schedule: airspaceSchedule,
          vertiport_status: vertiportStatus,
          departure_window_start: depStart,
        },
      });

      // Build a deterministic safe-default decision so the engine state is never empty
      const fallbackDecision: FlightDecisionResult = {
        decision_id: null,
        decision: tScore >= 75 && wRisk !== "high" && cCount === 0 ? "GO" : "DELAY",
        reason: decisionError
          ? "Decision engine recovered using local safety model — proceed with standard caution."
          : "Computed locally from latest trajectory analysis.",
        confidence: 70,
        departure_time: new Date(Date.now() + (tScore >= 75 ? 0 : 10) * 60_000).toISOString(),
        delay_minutes: tScore >= 75 ? 0 : 10,
        route_id: rData?.route_id ?? null,
        simulation: { safe: tScore >= 70, predicted_conflicts: cCount, weather_at_arrival: wRisk, energy_adequate: true, airspace_clear: (airspaceSchedule?.load_percentage ?? 0) < 80 },
        inputs_summary: {
          trajectory_score: tScore, weather_risk: wRisk, weather_risk_score: weatherIntel?.origin_weather?.risk_score ?? 0,
          conflicts: cCount, airspace_load: airspaceSchedule?.load_percentage ?? 0,
          vertiport_delay: vertiportStatus?.departure_delay_minutes ?? 0,
          route_score: rData?.primary_route?.overall_score ?? tScore, forecast_trend: weatherIntel?.forecast?.trend ?? "stable",
        },
      };

      const flightDecision: FlightDecisionResult = (decisionRes as FlightDecisionResult)?.decision
        ? (decisionRes as FlightDecisionResult)
        : fallbackDecision;

      console.info("[ATM] decision pipeline complete", {
        intentId,
        decision: flightDecision.decision,
        confidence: flightDecision.confidence,
        routeId: flightDecision.route_id,
        usedFallback: !decisionRes,
      });

      const clearanceMap = { GO: "auto-best", DELAY: "delayed-departure", REROUTE: "alternate-corridor" };
      updateData({
        selectedClearance: clearanceMap[flightDecision.decision] ?? "auto-best",
        selectedRouteId: flightDecision.route_id ?? rData?.route_id ?? null,
        atmEngines: {
          weatherIntel,
          airspaceSchedule,
          vertiportStatus,
          trajectoryPredict,
          flightDecision,
          atmLoading: false,
          atmError: nonBlockingErrors.length > 0 ? nonBlockingErrors.join(" | ") : null,
        },
      });
    } catch (e: any) {
      console.error("ATM engines failed — using safe-default decision:", e);
      const safeDecision: FlightDecisionResult = {
        decision_id: null, decision: "DELAY", reason: "Live analysis temporarily unavailable — holding 10 minutes for re-evaluation.",
        confidence: 60, departure_time: new Date(Date.now() + 10 * 60_000).toISOString(), delay_minutes: 10, route_id: rData?.route_id ?? null,
        simulation: { safe: false, predicted_conflicts: cCount, weather_at_arrival: wRisk, energy_adequate: true, airspace_clear: true },
        inputs_summary: { trajectory_score: tScore, weather_risk: wRisk, weather_risk_score: 0, conflicts: cCount, airspace_load: 0, vertiport_delay: 0, route_score: tScore, forecast_trend: "stable" },
      };
      updateData({
        atmEngines: { ...initialATMState, flightDecision: safeDecision, atmLoading: false, atmError: e?.message ?? "unknown" },
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

  const completeStep = () => {
    const err = validateStep(currentStep, data);
    if (err) {
      toast({ title: "Complete this step", description: err, variant: "destructive" });
      return;
    }
    setCompletedSteps((prev) => new Set([...prev, currentStep]));

    // Trigger all engines when leaving Intent step
    if (currentStep === 1) {
      // Run trajectory analysis first, then ATM engines with results
      (async () => {
        updateData({ analysisLoading: true, analysisComplete: false, routeLoading: true });
        let tScore = 80, wRisk = "low", cCount = 0, intentId: string | null = null;
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
              scheduled_departure: data.departureDate && data.departureWindowStart
                ? new Date(`${data.departureDate}T${data.departureWindowStart}:00`).toISOString()
                : null,
            },
          });
          if (error) throw new Error(error.message);
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
        } catch (e: any) {
          toast({ title: "Analysis failed", description: e.message, variant: "destructive" });
          updateData({ analysisLoading: false, routeLoading: false });
          return;
        }

        // Run route optimizer and ATM engines in parallel
        const [routeResult] = await Promise.allSettled([
          supabase.functions.invoke("route-optimizer", {
            body: {
              aircraft_id: data.aircraftId,
              operator_name: data.operatorName,
              origin: data.origin,
              destination: data.destination,
              altitude_band: data.altitudeBand,
              departure_window_start: data.departureWindowStart,
              departure_window_end: data.departureWindowEnd,
              flight_intent_id: intentId,
            },
          }),
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
      })();
    }

    if (currentStep < steps.length - 1) setCurrentStep(currentStep + 1);
  };

  const goBack = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  // Persist completed route to historical patterns so future flights learn from it
  const persistRoutePattern = async () => {
    const route = data.routeData?.primary_route;
    if (!route || !data.origin || !data.destination) return;
    const originKey = data.origin.toLowerCase().split("@")[0].trim();
    const destKey = data.destination.toLowerCase().split("@")[0].trim();
    try {
      const { data: existing } = await supabase
        .from("route_patterns")
        .select("*")
        .eq("origin_key", originKey)
        .eq("destination_key", destKey)
        .eq("altitude_band", data.altitudeBand)
        .maybeSingle();
      if (existing) {
        const n = (existing.flight_count ?? 0) + 1;
        const avg = (prev: number, next: number) => (prev * (n - 1) + next) / n;
        await supabase.from("route_patterns").update({
          flight_count: n,
          avg_overall_score: avg(Number(existing.avg_overall_score) || 0, route.overall_score),
          avg_safety_score: avg(Number(existing.avg_safety_score) || 0, route.safety_score),
          avg_weather_score: avg(Number(existing.avg_weather_score) || 0, route.weather_score),
          avg_traffic_score: avg(Number(existing.avg_traffic_score) || 0, route.traffic_score),
          avg_efficiency_score: avg(Number(existing.avg_efficiency_score) || 0, route.efficiency_score),
          preferred_waypoints: route.waypoints as unknown as Json,
          last_updated: new Date().toISOString(),
        }).eq("id", existing.id);
      } else {
        await supabase.from("route_patterns").insert([{
          origin_key: originKey, destination_key: destKey, altitude_band: data.altitudeBand,
          flight_count: 1,
          avg_overall_score: route.overall_score, avg_safety_score: route.safety_score,
          avg_weather_score: route.weather_score, avg_traffic_score: route.traffic_score,
          avg_efficiency_score: route.efficiency_score,
          preferred_waypoints: route.waypoints as unknown as Json,
        }]);
      }
      console.info("[learning] route_patterns updated for", originKey, "→", destKey);
    } catch (err) {
      console.warn("[learning] persistRoutePattern failed", err);
    }
  };

  const stepComponents = [
    <StepRegistration data={data} updateData={updateData} />,
    <StepIntent data={data} updateData={updateData} />,
    <StepClearance data={data} updateData={updateData} onSelectRoute={applyRouteSelection} />,
    <StepAuthority data={data} updateData={updateData} onApprove={persistRoutePattern} />,
    <StepMonitoring data={data} updateData={updateData} />,
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/40 backdrop-blur-xl sticky top-0 z-50">
        <div className="container flex items-center justify-between h-16">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm font-mono">Back</span>
          </button>
          <div className="flex items-center gap-2">
            <Plane className="w-4 h-4 text-primary" />
            <span className="font-semibold text-sm">Altos — Flight Planner</span>
          </div>
        </div>
      </header>

      <div className="container py-8">
        <div className="mb-10">
          <div className="flex items-center justify-between max-w-3xl mx-auto">
            {steps.map((step, i) => {
              // Hide registration step when logged in (it's already pre-filled)
              if (i === 0 && isLoggedIn) return null;
              const isActive = i === currentStep;
              const isCompleted = completedSteps.has(i);
              return (
                <div key={step.title} className="flex items-center">
                  <button
                    onClick={() => (isCompleted || i <= currentStep) && setCurrentStep(i)}
                    className={`flex flex-col items-center gap-2 group transition-all ${
                      isCompleted || i <= currentStep ? "cursor-pointer" : "cursor-not-allowed opacity-40"
                    }`}
                  >
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                        isActive
                          ? "bg-primary text-primary-foreground glow-primary"
                          : isCompleted
                          ? "bg-primary/20 text-primary border border-primary/40"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {isCompleted ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <step.icon className="w-4 h-4" />
                      )}
                    </div>
                    <span
                      className={`text-xs font-mono hidden md:block ${
                        isActive ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {step.title}
                    </span>
                  </button>
                  {i < steps.length - 1 && (
                    <div
                      className={`w-8 lg:w-16 h-px mx-1 ${
                        isCompleted ? "bg-primary/50" : "bg-border"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="max-w-3xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              <div className="mb-6">
                <span className="text-primary font-mono text-xs tracking-widest uppercase">
                  Step {isLoggedIn ? currentStep : currentStep + 1} of {isLoggedIn ? steps.length - 1 : steps.length}
                </span>
                <h2 className="text-2xl md:text-3xl font-bold mt-1">
                  {steps[currentStep].description}
                </h2>
              </div>

              <div className="glass-card rounded-xl p-6 md:p-8">
                {stepComponents[currentStep]}
              </div>
            </motion.div>
          </AnimatePresence>

          <div className="flex justify-between mt-8">
            <button
              onClick={goBack}
              disabled={currentStep === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-md border border-border text-foreground disabled:opacity-30 disabled:cursor-not-allowed hover:bg-secondary transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Previous
            </button>
            <button
              onClick={completeStep}
              disabled={data.analysisLoading || data.atmEngines.atmLoading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity font-medium disabled:opacity-50"
            >
              {currentStep === steps.length - 1 ? (
                completedSteps.has(steps.length - 1) ? "Mission Active ✓" : "Activate Monitoring"
              ) : (
                <>
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FlightPlan;
