// DEV-ONLY map test harness (route registered only when import.meta.env.DEV).
// Mounts the real map components outside AuthGuard so every map can be
// exercised headlessly: ?view=home | dashboard | flights | clearance | clearance-step | tracking | outside
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import LiveMapSection from "@/components/LiveMapSection";
import { OpsMap } from "@/pages/Dashboard";
import StepMonitoring from "@/components/flight-plan/StepMonitoring";
import RoutePreviewMap from "@/components/flight-plan/RoutePreviewMap";
import StepClearance from "@/components/flight-plan/StepClearance";
import { clearanceFixture } from "@/dev/clearanceFixture";
import type { FlightPlanData } from "@/pages/FlightPlan";
import type { Pt } from "@/lib/geo/region";
import { localDateISO } from "@/lib/time";

const leg = (a: [number, number], b: [number, number]): Pt[] => [{ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }];

// Realistic NYC-metro vertiport legs ([lng, lat]).
const OPS_ROUTES: Pt[][] = [
  leg([-74.0090, 40.7010], [-73.8740, 40.7769]), // Downtown Skyport → LGA
  leg([-73.9712, 40.7425], [-74.1745, 40.6895]), // E34th → EWR
  leg([-73.9857, 40.7484], [-73.7781, 40.6413]), // Midtown → JFK
  leg([-74.0776, 40.7282], [-73.9442, 40.8030]), // Jersey City → Harlem
];
const OUTSIDE_ROUTES: Pt[][] = [leg([-73.7781, 40.6413], [-0.4543, 51.4700])]; // JFK → LHR

const trackingData = (): FlightPlanData => ({
  aircraftId: "N123EV", operatorName: "Map Test", aircraftType: "evtol",
  origin: "Downtown Skyport @40.7010,-74.0090", destination: "LaGuardia @40.7769,-73.8740",
  altitudeBand: "low", departureWindowStart: "09:00", departureWindowEnd: "09:30",
  departureDate: localDateISO(), conflicts: 0, trajectoryScore: 92,
  weatherRisk: "low", selectedClearance: "", bestDepartureTime: "09:05", authorityApproved: true,
  monitoringActive: true, analysisComplete: true, analysisLoading: false, routeData: null,
  routeLoading: false, selectedRouteId: null, flightIntentId: null,
  atmEngines: { weatherIntel: null, airspaceSchedule: null, vertiportStatus: null, trajectoryPredict: null, flightDecision: null, atmLoading: false, atmError: null },
});

export default function MapTest() {
  const [params] = useSearchParams();
  const view = params.get("view") ?? "home";
  const [data, setData] = useState<FlightPlanData>(trackingData);

  if (view === "home") return <main className="bg-background"><LiveMapSection /></main>;
  if (view === "tracking") {
    return (
      <main className="bg-background p-4">
        <StepMonitoring data={data} updateData={(u) => setData((d) => ({ ...d, ...u }))} />
      </main>
    );
  }
  if (view === "clearance-step") {
    return <ClearanceStepHarness />;
  }
  if (view === "clearance") {
    return (
      <main className="bg-background p-4">
        <div className="relative h-[70vh] rounded-2xl overflow-hidden"><RoutePreviewMap data={data} /></div>
      </main>
    );
  }
  return (
    <main className="bg-background relative" style={{ height: "100vh" }}>
      {view === "dashboard" && <OpsMap routes={OPS_ROUTES} />}
      {view === "flights" && <OpsMap />}
      {view === "outside" && <OpsMap routes={OUTSIDE_ROUTES} />}
    </main>
  );
}

function ClearanceStepHarness() {
  const [params] = useSearchParams();
  // ?degraded=1 → weather unavailable + no registered vertiport near origin.
  const [data, setData] = useState<FlightPlanData>(() => {
    const d = clearanceFixture();
    if (params.get("degraded") !== "1") return d;
    return {
      ...d,
      routeData: d.routeData && { ...d.routeData, weather_conditions: null, weather_risk: "unknown" },
      atmEngines: {
        ...d.atmEngines,
        weatherIntel: null,
        vertiportStatus: d.atmEngines.vertiportStatus && {
          ...d.atmEngines.vertiportStatus,
          origin_vertiport: { name: "No registered vertiport within 3 km", load_pct: 0, capacity_ok: true, checked: false },
          capacity_source: "configured planning values",
        },
        flightDecision: d.atmEngines.flightDecision && {
          ...d.atmEngines.flightDecision, decision: "DELAY", confidence: 50,
          reason: "Live weather for the departure time is unavailable — holding 10 minutes for re-evaluation. A GO is never issued without weather data.",
          inputs_summary: { ...d.atmEngines.flightDecision.inputs_summary, weather_risk: "unknown", weather_risk_score: null, airspace_load: null },
        },
        atmError: "weather-intelligence: weather_unavailable",
      },
    };
  });
  return (
    <main className="bg-background min-h-screen px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      <StepClearance
        data={data}
        updateData={(u) => setData((d) => ({ ...d, ...u }))}
        onSelectRoute={(id) => setData((d) => ({ ...d, selectedRouteId: id }))}
      />
    </main>
  );
}
