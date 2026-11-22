// DEV-ONLY fixture for the /__maptest harness (never imported by app routes).
// Shapes match the real edge-function responses so StepClearance can be
// exercised visually without a signed-in session.
import type { FlightPlanData } from "@/pages/FlightPlan";
import type { RouteCandidate, RouteOptimizerResult } from "@/lib/routeTypes";

const base = { safety_score: 92, weather_score: 84, traffic_score: 88, efficiency_score: 79, is_selected: false };
const route = (id: string, label: string, wps: [number, number][], score: number, km: number, min: number): RouteCandidate => ({
  ...base, id, label, overall_score: score, distance_km: km, estimated_time_min: min,
  waypoints: wps.map(([lat, lon]) => ({ lat, lon })),
});

const primary = { ...route("r-primary", "East River corridor", [[40.7011, -74.0090], [40.7200, -73.9740], [40.7480, -73.9600], [40.7769, -73.8740]], 88, 14.2, 11), is_selected: true, selection_reason: "Highest combined safety and traffic score; avoids the Midtown helicopter corridor.",
  airspace_restrictions: [{ source: "faa-tfr" as const, notam: "0/0000 (fixture)", name: "Fixture VIP TFR", type: "VIP", valid_from: new Date().toISOString(), valid_to: new Date(Date.now() + 3 * 3600e3).toISOString(), alt_low_ft: 0, alt_high_ft: 3000, geometry_approximated: false, severity: "high" as const }],
  weather_advisories: [{ source: "awc", kind: "G-AIRMET", hazard: "ICE", valid_from: new Date().toISOString(), valid_to: new Date(Date.now() + 3600e3).toISOString(), severity: "moderate" as const, headline: null, external_id: "fixture-ice" }],
  live_traffic: [{ source: "opensky" as const, icao24: "a0b1c2", callsign: "FIXTURE1", distance_m: 820, altitude_m: 310, age_s: 12, severity: "moderate" as const }] };
const alt1 = route("r-alt1", "Queens overland", [[40.7011, -74.0090], [40.7100, -73.9500], [40.7450, -73.9100], [40.7769, -73.8740]], 81, 15.8, 13);
const alt2 = route("r-alt2", "Midtown direct", [[40.7011, -74.0090], [40.7420, -73.9900], [40.7650, -73.9400], [40.7769, -73.8740]], 74, 13.6, 10);

export const ROUTE_FIXTURE: RouteOptimizerResult = {
  route_id: "fixture",
  primary_route: primary,
  alternate_routes: [alt1, alt2],
  conflict_details: [],
  conflict_check: { status: "checked_clear", evaluated_flights: 6, skipped_flights: 1, method: "spatiotemporal", generated_at: new Date().toISOString() },
  weather_conditions: { wind_speed: 18, wind_gusts: 27, precipitation: 0, temperature: 14, weather_code: 2, visibility: 16000 },
  weather_risk: "low",
  historical_suggestion: { found: true, source: "verified_past_flights", verified_flights: 9, median_duration_min: 11.4, median_deviation_m: 140, message: "9 GPS-verified flight(s) on this route · median 11.4 min. (fixture)" },
  // Fixture shapes only (dev harness) — labelled so they can never pass for real data.
  external_data: {
    ok: false, problems: ["NWS active alerts: stale (fixture)"], checked_at: new Date().toISOString(),
    sources: ["awc-metar", "awc-taf", "awc-airsigmet", "awc-gairmet", "faa-tfr", "opensky"].map((id) => ({ id, name: id, freshness: "fresh", last_success_at: new Date().toISOString(), last_data_at: null }))
      .concat([{ id: "nws-alerts", name: "NWS active alerts", freshness: "stale", last_success_at: null, last_data_at: null }]),
  },
  live_traffic: { applicable: true, reason: "ADS-B snapshot (fixture)", hits: [] },
  analysis_summary: {
    total_conflicts: 0, routes_evaluated: 12, optimization_method: "A* weighted",
    scoring_weights: { weight_safety: 0.35, weight_weather: 0.2, weight_traffic: 0.2, weight_efficiency: 0.1, weight_time: 0.1, weight_fuel: 0.05 },
  },
};

export const clearanceFixture = (): FlightPlanData => ({
  aircraftId: "N123EV", operatorName: "Map Test", aircraftType: "evtol",
  origin: "Downtown Skyport @40.7011,-74.0090", destination: "LaGuardia @40.7769,-73.8740",
  altitudeBand: "low", departureWindowStart: "09:00", departureWindowEnd: "09:10",
  departureDate: new Date().toISOString().split("T")[0], conflicts: 0, trajectoryScore: 88,
  weatherRisk: "low", selectedClearance: "auto-best", bestDepartureTime: "09:05", authorityApproved: false,
  monitoringActive: false, analysisComplete: true, analysisLoading: false, routeData: ROUTE_FIXTURE,
  routeLoading: false, selectedRouteId: "r-primary", flightIntentId: null,
  atmEngines: {
    weatherIntel: {
      origin_weather: { wind_speed: 18, wind_gusts: 27, precipitation: 0, temperature: 14, weather_code: 2, weather_description: "Partly cloudy", visibility_m: 16000, risk_score: 22, risk_level: "low" },
      destination_weather: { wind_speed: 20, wind_gusts: 29, precipitation: 0, weather_code: 2, weather_description: "Partly cloudy", risk_score: 24, risk_level: "low" },
      forecast: { t_plus_15: { risk_score: 25, uncertainty_pct: 8 }, t_plus_30: { risk_score: 31, uncertainty_pct: 14 }, trend: "degrading" },
      recommendation: "proceed", recommendation_reason: "", suggested_delay_minutes: 0, suggested_altitude_band: null, altitude_risk_modifier: 0,
    },
    airspaceSchedule: null, // simulate a non-responding engine
    vertiportStatus: {
      origin_vertiport: { name: "Downtown Skyport", load_pct: 42, capacity_ok: true, departures_in_window: 3, max_departures_per_hour: 12 },
      destination_vertiport: { name: "LaGuardia", load_pct: 67, capacity_ok: true, arrivals_in_window: 5, max_arrivals_per_hour: 10 },
      departure_capacity_ok: true, arrival_capacity_ok: true, departure_delay_minutes: 0,
      adjusted_departure_time: new Date().toISOString(), estimated_arrival_time: new Date(Date.now() + 11 * 60_000).toISOString(),
      flight_time_minutes: 11, distance_km: 14.2, reason: "Capacity available at both ends.",
    },
    trajectoryPredict: {
      predictions: [], total_active_flights: 6, system_flow_efficiency: 91, total_conflicts_detected: 1, high_severity_conflicts: 0, analysis_horizon_minutes: 15,
      future_conflicts: [{ aircraft_a: "N123EV", aircraft_b: "N88SK", t_plus_min: 7, separation_km: 0.42, severity: "moderate", resolution: { type: "altitude_adjustment", action: "Climb to MID band before the Queensboro crossing" } }],
    },
    flightDecision: {
      decision_id: null, decision: "GO", reason: "Route clear of high-severity conflicts; weather within limits; vertiport capacity available.",
      confidence: 87, departure_time: new Date().toISOString(), delay_minutes: 0, route_id: "r-primary",
      simulation: { safe: true, predicted_conflicts: 1, weather_at_arrival: "low", energy_adequate: true, airspace_clear: true },
      inputs_summary: { trajectory_score: 88, weather_risk: "low", weather_risk_score: 22, conflicts: 0, airspace_load: 0, vertiport_delay: 0, route_score: 88, forecast_trend: "degrading" },
    },
    atmLoading: false,
    atmError: "airspace-scheduler: timeout",
  },
});
