// ─────────────────────────────────────────────────────────────────────────────
// Advanced ATM TypeScript Types
// ─────────────────────────────────────────────────────────────────────────────

// Weather Intelligence
export interface WeatherAtLocation {
  wind_speed: number;
  wind_gusts: number;
  precipitation: number;
  temperature: number;
  weather_code: number;
  weather_description: string;
  visibility_m: number;
  risk_score: number;
  risk_level: "low" | "moderate" | "high";
  micro_effects?: string[];
}

export interface WeatherForecastPoint {
  risk_score: number;
  uncertainty_pct: number;
}

export interface WeatherIntelligenceResult {
  origin_weather: WeatherAtLocation;
  destination_weather: Omit<WeatherAtLocation, "visibility_m" | "temperature" | "micro_effects">;
  forecast: {
    t_plus_15: WeatherForecastPoint;
    t_plus_30: WeatherForecastPoint;
    trend: "improving" | "degrading" | "stable";
  };
  recommendation: "proceed" | "delay" | "reroute";
  recommendation_reason: string;
  suggested_delay_minutes: number;
  suggested_altitude_band: string | null;
  altitude_risk_modifier: number;
}

// Airspace Scheduling
export interface AirspaceScheduleResult {
  allocated: boolean;
  allocated_time: string;
  delay_minutes: number;
  priority: number;
  segment_name: string;
  segment_load: number;
  segment_capacity: number;
  load_percentage: number;
  is_congested: boolean;
  reason: string;
  competing_flights: number;
}

// Vertiport Coordination
export interface VertiportInfo {
  id?: string;
  name: string;
  departures_in_window?: number;
  arrivals_in_window?: number;
  max_departures_per_hour?: number;
  max_arrivals_per_hour?: number;
  load_pct: number;
  capacity_ok: boolean;
}

export interface VertiportStatusResult {
  origin_vertiport: VertiportInfo;
  destination_vertiport: VertiportInfo;
  departure_capacity_ok: boolean;
  arrival_capacity_ok: boolean;
  departure_delay_minutes: number;
  adjusted_departure_time: string;
  estimated_arrival_time: string;
  flight_time_minutes: number;
  distance_km: number;
  reason: string;
}

// Trajectory Prediction
export interface PredictedPosition {
  t_plus_min: number;
  lat: number;
  lon: number;
  altitude_band: string;
}

export interface FlightPrediction {
  flight_intent_id: string;
  aircraft_id: string;
  altitude_band: string;
  current_progress: number;
  predicted_positions: PredictedPosition[];
  origin: string;
  destination: string;
  status: string;
}

export interface ConflictResolution {
  type: "altitude_adjustment" | "speed_adjustment" | "route_deviation";
  action: string;
}

export interface FutureConflict {
  aircraft_a: string;
  aircraft_b: string;
  t_plus_min: number;
  separation_km: number;
  severity: "low" | "moderate" | "high";
  resolution: ConflictResolution;
}

export interface TrajectoryPredictorResult {
  predictions: FlightPrediction[];
  future_conflicts: FutureConflict[];
  total_active_flights: number;
  system_flow_efficiency: number;
  total_conflicts_detected: number;
  high_severity_conflicts: number;
  analysis_horizon_minutes: number;
}

// Flight Decision Engine
export type FlightDecision = "GO" | "DELAY" | "REROUTE";

export interface SimulationResult {
  safe: boolean;
  predicted_conflicts: number;
  weather_at_arrival: string;
  energy_adequate: boolean;
  airspace_clear: boolean;
}

export interface FlightDecisionResult {
  decision_id: string | null;
  decision: FlightDecision;
  reason: string;
  confidence: number;
  departure_time: string;
  delay_minutes: number;
  route_id: string | null;
  simulation: SimulationResult;
  inputs_summary: {
    trajectory_score: number;
    weather_risk: string;
    weather_risk_score: number;
    conflicts: number;
    airspace_load: number;
    vertiport_delay: number;
    route_score: number;
    forecast_trend: string;
  };
}

// Anomaly
export interface AnomalyRecord {
  id: string;
  flight_intent_id: string;
  aircraft_id: string;
  anomaly_type: "route_deviation" | "unexpected_slowdown" | "battery_risk" | "weather_spike" | "airspace_breach" | "conflict_proximity";
  severity: "low" | "moderate" | "high" | "critical";
  description: string;
  lat?: number;
  lon?: number;
  detected_at: string;
  resolved_at?: string;
  is_active: boolean;
}

// Combined ATM state used in FlightPlan
export interface ATMEngineState {
  weatherIntel: WeatherIntelligenceResult | null;
  airspaceSchedule: AirspaceScheduleResult | null;
  vertiportStatus: VertiportStatusResult | null;
  trajectoryPredict: TrajectoryPredictorResult | null;
  flightDecision: FlightDecisionResult | null;
  atmLoading: boolean;
  atmError: string | null;
}
