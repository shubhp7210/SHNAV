// DEV-ONLY map test harness (route registered only when import.meta.env.DEV).
// Mounts the real map components outside AuthGuard so every map can be
// exercised headlessly: ?view=home | dashboard | flights | tracking | outside
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import LiveMapSection from "@/components/LiveMapSection";
import { OpsMap } from "@/pages/Dashboard";
import StepMonitoring from "@/components/flight-plan/StepMonitoring";
import type { FlightPlanData } from "@/pages/FlightPlan";

// Realistic NYC-metro vertiport legs ([lng, lat]).
const OPS_ROUTES = [
  { from: [-74.0090, 40.7010], to: [-73.8740, 40.7769], status: "active" },   // Downtown Skyport → LGA
  { from: [-73.9712, 40.7425], to: [-74.1745, 40.6895], status: "approved" }, // E34th → EWR
  { from: [-73.9857, 40.7484], to: [-73.7781, 40.6413], status: "in_air" },   // Midtown → JFK
  { from: [-74.0776, 40.7282], to: [-73.9442, 40.8030], status: "pending" },  // Jersey City → Harlem
] as { from: [number, number]; to: [number, number]; status: string }[];

const OUTSIDE_ROUTES = [
  { from: [-73.7781, 40.6413], to: [-0.4543, 51.4700], status: "active" }, // JFK → LHR
] as typeof OPS_ROUTES;

const trackingData = (): FlightPlanData => ({
  aircraftId: "N123EV", operatorName: "Map Test", aircraftType: "evtol",
  origin: "Downtown Skyport @40.7010,-74.0090", destination: "LaGuardia @40.7769,-73.8740",
  altitudeBand: "low", departureWindowStart: "09:00", departureWindowEnd: "09:30",
  departureDate: new Date().toISOString().split("T")[0], conflicts: 0, trajectoryScore: 92,
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
  return (
    <main className="bg-background relative" style={{ height: "100vh" }}>
      {view === "dashboard" && <OpsMap routes={OPS_ROUTES} />}
      {view === "flights" && <OpsMap interactive />}
      {view === "outside" && <OpsMap routes={OUTSIDE_ROUTES} interactive />}
    </main>
  );
}
