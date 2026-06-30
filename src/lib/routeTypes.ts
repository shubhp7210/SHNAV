export interface RouteWaypoint {
  lat: number;
  lon: number;
}

export interface RouteCandidate {
  id: string;
  label: string;
  waypoints: RouteWaypoint[];
  distance_km: number;
  estimated_time_min: number;
  overall_score: number;
  safety_score: number;
  weather_score: number;
  traffic_score: number;
  efficiency_score: number;
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
  wind_gusts: number;
  precipitation: number;
  temperature: number;
  weather_code: number;
  visibility: number;
}

export interface HistoricalSuggestion {
  found: boolean;
  flight_count?: number;
  avg_score?: number;
  suggested_waypoints?: RouteWaypoint[];
  message?: string;
}

export interface RouteOptimizerResult {
  route_id: string;
  primary_route: RouteCandidate;
  alternate_routes: RouteCandidate[];
  conflict_details: ConflictDetail[];
  weather_conditions: WeatherConditions;
  weather_risk: "low" | "moderate" | "high" | "unknown";
  historical_suggestion: HistoricalSuggestion;
  analysis_summary: {
    total_conflicts: number;
    routes_evaluated: number;
    optimization_method: string;
    scoring_weights: {
      safety: number;
      weather: number;
      traffic: number;
      efficiency: number;
    };
  };
}
