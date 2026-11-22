// ── Real external data (FAA TFRs, AWC/NWS advisories, OpenSky ADS-B) ────────
export interface RestrictionHit {
  source: "faa-tfr"; notam: string; name: string | null; type: string | null;
  valid_from: string | null; valid_to: string | null; alt_low_ft: number | null; alt_high_ft: number | null;
  geometry_approximated: boolean; severity: "high";
}
export interface AdvisoryHit {
  source: string; kind: string; hazard: string | null; valid_from: string; valid_to: string;
  severity: "high" | "moderate" | "low"; headline: string | null; external_id: string;
}
export interface LiveTrafficHit {
  source: "opensky"; icao24: string; callsign: string | null; distance_m: number; altitude_m: number | null;
  age_s: number; severity: "high" | "moderate" | "low";
}
export interface LiveTrafficCheck { applicable: boolean; reason: string; hits: LiveTrafficHit[] }
export interface SourceStatus { id: string; name: string; freshness: string; last_success_at: string | null; last_data_at: string | null }
export interface ExternalDataStatus { ok: boolean; problems: string[]; sources: SourceStatus[]; checked_at: string }

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
  airspace_restrictions?: RestrictionHit[];
  weather_advisories?: AdvisoryHit[];
  live_traffic?: LiveTrafficHit[];
  /** Raw (uncalibrated) estimate; estimated_time_min applies the promoted duration model. */
  raw_estimated_time_min?: number;
  duration_calibration_factor?: number;
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

/** Descriptive statistics from GPS-verified past flights on this route. */
export interface HistoricalSuggestion {
  found: boolean;
  source?: "verified_past_flights";
  model_version?: number | null;
  verified_flights?: number;
  median_duration_min?: number;
  median_deviation_m?: number;
  message?: string;
}

export interface RouteOptimizerResult {
  route_id: string;
  top_routes?: RouteCandidate[];
  primary_route: RouteCandidate;
  alternate_routes: RouteCandidate[];
  conflict_details: ConflictDetail[];
  /** Traceable conflict-check result. `checked_clear` only after ≥1 flight was
   *  evaluated with no conflict; `incomplete` when required data was missing. */
  conflict_check?: {
    status: "checked_clear" | "conflicts" | "incomplete";
    evaluated_flights: number;
    skipped_flights: number;
    method: string;
    generated_at: string;
  };
  /** null when the departure-time forecast was unavailable. */
  weather_conditions: WeatherConditions | null;
  weather_data?: { available_samples: number; total_samples: number; valid_for: string };
  weather_risk: "low" | "moderate" | "high" | "unknown";
  historical_suggestion: HistoricalSuggestion;
  external_data?: ExternalDataStatus | null;
  live_traffic?: LiveTrafficCheck | null;
  model_versions?: Record<string, number>;
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
