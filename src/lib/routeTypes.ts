export interface RouteWaypoint {
  lat: number;
  lon: number;
}

export interface WindDrift {
  avg_headwind_kmh: number;
  avg_crosswind_kmh: number;
  time_penalty_minutes: number;
  max_lateral_drift_m: number;
  recommended_heading_correction_deg: number;
  wind_effect: "headwind" | "tailwind" | "crosswind";
}

export interface RouteHazards {
  turbulence_probability: number;
  icing_probability: number;
  worst_weather_code: number;
  min_visibility_m: number;
}

export interface RouteCandidate {
  id: string;
  label: string;
  rank?: number;
  waypoints: RouteWaypoint[];
  distance_km: number;
  estimated_time_min: number;
  overall_score: number;
  safety_score: number;
  weather_score: number;
  traffic_score: number;
  efficiency_score: number;
  time_score?: number;
  wind_score?: number;
  turbulence_score?: number;
  fuel_score?: number;
  wind_drift?: WindDrift;
  violated_no_fly_zone?: string | null;
  wind_summary?: { avg_headwind_kmh: number; avg_crosswind_kmh: number };
  hazards?: RouteHazards;
  operational_note?: string;
  is_selected: boolean;
  selection_reason?: string;
}

export interface ConflictDetail {
  aircraft_id: string;
  conflict_type: string;
  severity: "high" | "moderate" | "low";
}

export interface WeatherConditions {
  wind_speed: number;
  wind_direction_deg?: number;
  wind_gusts: number;
  precipitation: number;
  temperature: number;
  weather_code: number;
  visibility: number;
}

export interface HistoricalSuggestion {
  found: boolean;
  is_user_specific?: boolean;
  flight_count?: number;
  completed_flight_count?: number;
  avg_score?: number;
  outcome_adjusted_score?: number | null;
  message?: string;
}

export interface RouteOptimizerResult {
  route_id: string;
  top_routes?: RouteCandidate[];
  primary_route: RouteCandidate;
  alternate_routes: RouteCandidate[];
  conflict_details: ConflictDetail[];
  weather_conditions: WeatherConditions;
  weather_risk: "low" | "moderate" | "high" | "unknown";
  historical_suggestion: HistoricalSuggestion;
  analysis_summary: {
    total_conflicts: number;
    routes_evaluated: number;
    routes_returned?: number;
    no_fly_zones_checked?: number;
    optimization_method: string;
    scoring_weights: {
      weight_safety: number;
      weight_weather: number;
      weight_traffic: number;
      weight_efficiency: number;
      weight_time: number;
      weight_fuel: number;
    };
  };
}
