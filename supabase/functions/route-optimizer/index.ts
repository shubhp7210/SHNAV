// Route optimizer — generates multiple candidate routes, scores them on
// time / wind / weather / turbulence / fuel / traffic / safety, and returns
// the top 3. Weights are pulled from route_score_config so the learning loop
// can adjust them from actual outcomes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, EVTOL_BASE_SPEED_KMH } from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { getCoords } from "../_shared/geocode.ts";
import {
  bearingDeg,
  haversineKm as haversine,
  type LatLon,
  windRelativeToHeading,
} from "../_shared/geo.ts";
import {
  icingFromWeather,
  turbulenceFromGustCross,
  weatherSeverity,
  WxCache,
} from "../_shared/weather.ts";

const corsHeaders = CORS_HEADERS;
const KM_PER_DEG_LAT = 111.32;

// ── Route geometry ──────────────────────────────────────────────────────────

function directRoute(o: LatLon, d: LatLon, n: number): LatLon[] {
  const pts: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([o[0] + (d[0] - o[0]) * t, o[1] + (d[1] - o[1]) * t]);
  }
  return pts;
}

function deviationRoute(o: LatLon, d: LatLon, offsetKm: number, n = 24): LatLon[] {
  const [oLat, oLon] = o;
  const [dLat, dLon] = d;
  const bearing = bearingDeg(oLat, oLon, dLat, dLon);
  const perpBearing = (bearing - 90 + 360) % 360;
  const perpRad = (perpBearing * Math.PI) / 180;
  const dLatPerKm = 1 / KM_PER_DEG_LAT;
  const midLat = (oLat + dLat) / 2;
  const dLonPerKm = 1 / (KM_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180) || 1e-6);
  const perpLat = Math.cos(perpRad) * dLatPerKm;
  const perpLon = Math.sin(perpRad) * dLonPerKm;
  const pts: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const baseLat = oLat + (dLat - oLat) * t;
    const baseLon = oLon + (dLon - oLon) * t;
    const bulge = Math.sin(Math.PI * t) * offsetKm;
    pts.push([baseLat + bulge * perpLat, baseLon + bulge * perpLon]);
  }
  return pts;
}

function routeDistance(pts: LatLon[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  return d;
}

function samplePointsAlongRoute(pts: LatLon[], k: number): LatLon[] {
  if (k <= 0 || pts.length < 2) return [];
  const out: LatLon[] = [];
  for (let i = 0; i < k; i++) {
    const t = i / (k - 1);
    const target = t * (pts.length - 1);
    const lo = Math.floor(target);
    const hi = Math.min(pts.length - 1, lo + 1);
    const frac = target - lo;
    out.push([pts[lo][0] + (pts[hi][0] - pts[lo][0]) * frac, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * frac]);
  }
  return out;
}

// ── Airspace zone check ─────────────────────────────────────────────────────
// Simple point-in-polygon (ray casting) for boundary_polygon JSONB arrays.

interface PolyPoint { lat: number; lon: number }

function pointInPolygon(lat: number, lon: number, polygon: PolyPoint[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lon, yi = polygon[i].lat;
    const xj = polygon[j].lon, yj = polygon[j].lat;
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function routeIntersectsNoFly(
  waypoints: LatLon[],
  noFlyZones: Array<{ name: string; boundary_polygon: PolyPoint[] }>,
): string | null {
  for (const zone of noFlyZones) {
    if (!zone.boundary_polygon || zone.boundary_polygon.length < 3) continue;
    const samplePts = samplePointsAlongRoute(waypoints, 12);
    for (const [lat, lon] of samplePts) {
      if (pointInPolygon(lat, lon, zone.boundary_polygon)) {
        return zone.name;
      }
    }
  }
  return null;
}

// ── Per-route evaluation ────────────────────────────────────────────────────

interface RouteEval {
  distanceKm: number;
  timeMin: number;
  baseTimeMin: number;
  avgHeadwindKmh: number;
  avgCrosswindKmh: number;
  avgWxSeverity: number;
  maxWxSeverity: number;
  avgTurbulence: number;
  maxTurbulence: number;
  avgIcing: number;
  avgVisibilityM: number;
  worstWeatherCode: number;
  trafficPenalty: number;
}

async function evaluateRoute(
  waypoints: LatLon[],
  wxCache: WxCache,
  conflictDensity: number,
  sampleCount = 6,
): Promise<RouteEval> {
  const distanceKm = routeDistance(waypoints);
  const samples = samplePointsAlongRoute(waypoints, sampleCount);
  const wxList = await Promise.all(samples.map((p) => wxCache.get(p[0], p[1])));

  const bearings: number[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    bearings.push(bearingDeg(waypoints[i - 1][0], waypoints[i - 1][1], waypoints[i][0], waypoints[i][1]));
  }

  let sumHead = 0, sumCross = 0, sumWxSev = 0, maxWxSev = 0, sumTurb = 0, maxTurb = 0, sumIcing = 0, sumVis = 0, worstWxCode = 0;
  for (let i = 0; i < wxList.length; i++) {
    const wx = wxList[i];
    const t = i / Math.max(1, wxList.length - 1);
    const legIdx = Math.min(bearings.length - 1, Math.max(0, Math.floor(t * bearings.length)));
    const heading = bearings[legIdx] ?? bearings[0] ?? 0;
    const rel = windRelativeToHeading(heading, wx.windFromDeg, wx.windSpeedKmh);
    sumHead += rel.headwindKmh;
    sumCross += rel.crosswindKmh;
    const sev = weatherSeverity(wx);
    sumWxSev += sev;
    if (sev > maxWxSev) maxWxSev = sev;
    const turb = turbulenceFromGustCross(wx.windGustsKmh, rel.crosswindKmh);
    sumTurb += turb;
    if (turb > maxTurb) maxTurb = turb;
    sumIcing += icingFromWeather(wx);
    sumVis += wx.visibilityM;
    if (wx.weatherCode > worstWxCode) worstWxCode = wx.weatherCode;
  }
  const n = Math.max(1, wxList.length);
  const effectiveSpeed = Math.max(40, EVTOL_BASE_SPEED_KMH - sumHead / n);
  const timeMin = (distanceKm / effectiveSpeed) * 60;
  const baseTimeMin = (distanceKm / EVTOL_BASE_SPEED_KMH) * 60;

  return {
    distanceKm, timeMin, baseTimeMin,
    avgHeadwindKmh: sumHead / n,
    avgCrosswindKmh: sumCross / n,
    avgWxSeverity: sumWxSev / n,
    maxWxSeverity: maxWxSev,
    avgTurbulence: sumTurb / n,
    maxTurbulence: maxTurb,
    avgIcing: sumIcing / n,
    avgVisibilityM: sumVis / n,
    worstWeatherCode: worstWxCode,
    trafficPenalty: conflictDensity,
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

interface ScoreWeights {
  weight_safety: number; weight_weather: number; weight_traffic: number;
  weight_efficiency: number; weight_time: number; weight_fuel: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = {
  weight_safety: 0.22, weight_weather: 0.18, weight_traffic: 0.15,
  weight_efficiency: 0.15, weight_time: 0.20, weight_fuel: 0.10,
};

function scoreEval(ev: RouteEval, fastestTimeMin: number, shortestDistKm: number, weights: ScoreWeights) {
  const timeDelta = Math.max(0, ev.timeMin - fastestTimeMin);
  const timeScore = Math.max(10, 100 - (timeDelta / Math.max(1, fastestTimeMin)) * 120);
  const windScore = Math.max(10, Math.min(100, 60 - ev.avgHeadwindKmh * 1.2 - ev.avgCrosswindKmh * 0.5 + 40));
  const wxScore = Math.max(10, 100 - ev.avgWxSeverity * 80 - ev.maxWxSeverity * 20);
  const turbScore = Math.max(10, 100 - ev.avgTurbulence * 70 - ev.maxTurbulence * 30);
  const fuelRatio = ev.timeMin / Math.max(1, ev.baseTimeMin);
  const fuelScore = Math.max(10, 100 - (fuelRatio - 1) * 180);
  const trafScore = Math.max(10, 100 - Math.min(5, ev.trafficPenalty) * 16);
  const distRatio = ev.distanceKm / Math.max(0.01, shortestDistKm);
  const effScore = Math.max(10, 100 - (distRatio - 1) * 140 - ev.avgIcing * 30);
  const visPenalty = ev.avgVisibilityM < 5000 ? (5000 - ev.avgVisibilityM) / 50 : 0;
  const safetyScore = Math.max(10, 100 - ev.maxWxSeverity * 35 - ev.maxTurbulence * 25 - ev.avgIcing * 25 - visPenalty);
  const w = weights;
  const overall =
    safetyScore * w.weight_safety + wxScore * w.weight_weather + trafScore * w.weight_traffic +
    effScore * w.weight_efficiency + timeScore * w.weight_time + fuelScore * w.weight_fuel;
  const round = (n: number) => Math.round(n);
  return { overall: round(overall), time: round(timeScore), wind: round(windScore), weather: round(wxScore), turbulence: round(turbScore), fuel: round(fuelScore), traffic: round(trafScore), safety: round(safetyScore), efficiency: round(effScore) };
}

// ── Candidate generation ────────────────────────────────────────────────────

interface Candidate { id: string; label: string; waypoints: LatLon[] }

function buildCandidates(o: LatLon, d: LatLon): Candidate[] {
  const distKm = haversine(o[0], o[1], d[0], d[1]);
  const small = Math.max(2, distKm * 0.06);
  const large = Math.max(5, distKm * 0.15);
  return [
    { id: "direct",            label: "Direct route",                waypoints: directRoute(o, d, 24) },
    { id: "port-shallow",      label: "Port deviation (small)",      waypoints: deviationRoute(o, d, +small) },
    { id: "starboard-shallow", label: "Starboard deviation (small)", waypoints: deviationRoute(o, d, -small) },
    { id: "port-wide",         label: "Port deviation (wide)",       waypoints: deviationRoute(o, d, +large) },
    { id: "starboard-wide",    label: "Starboard deviation (wide)",  waypoints: deviationRoute(o, d, -large) },
  ];
}

// ── Traffic conflict detection ───────────────────────────────────────────────

function timeToMinutes(t: string): number {
  const [h, m] = (t ?? "00:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function windowsOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return timeToMinutes(s1) < timeToMinutes(e2) && timeToMinutes(s2) < timeToMinutes(e1);
}

interface ConflictEntry { aircraft_id: string; conflict_type: string; severity: "high" | "moderate" | "low" }

// ── Wind drift analysis ──────────────────────────────────────────────────────

function computeWindDrift(ev: RouteEval) {
  const durationS = ev.timeMin * 60;
  // Lateral drift from crosswind over the flight duration, in metres.
  const lateralDriftM = Math.round(ev.avgCrosswindKmh * (1000 / 3600) * durationS);
  // Time penalty vs no-wind baseline (positive = slower than no-wind).
  const timePenaltyMin = Math.round((ev.timeMin - ev.baseTimeMin) * 10) / 10;
  // Recommended correction: cross-track angle in degrees.
  const correctionDeg = Math.round(
    Math.atan2(ev.avgCrosswindKmh, EVTOL_BASE_SPEED_KMH) * (180 / Math.PI) * 10,
  ) / 10;
  return {
    avg_headwind_kmh: Math.round(ev.avgHeadwindKmh),
    avg_crosswind_kmh: Math.round(ev.avgCrosswindKmh),
    time_penalty_minutes: timePenaltyMin,
    max_lateral_drift_m: lateralDriftM,
    recommended_heading_correction_deg: correctionDeg,
    wind_effect: ev.avgHeadwindKmh > 5 ? "headwind" : ev.avgHeadwindKmh < -5 ? "tailwind" : "crosswind",
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const user = await requireUserAuth(req);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const { aircraft_id, operator_name, origin, destination, altitude_band, departure_window_start, departure_window_end, flight_intent_id } = body;

    if (!origin || !destination) {
      return json({ error: "origin and destination are required" }, 400);
    }

    // Ownership check when flight_intent_id is provided.
    if (flight_intent_id) {
      const { data: ownedIntent } = await supabase
        .from("flight_intents")
        .select("id")
        .eq("id", flight_intent_id)
        .eq("user_id", user.id)
        .single();
      if (!ownedIntent) {
        return json({ error: "Flight intent not found or access denied" }, 403);
      }
    }

    const originCoords = await getCoords(origin);
    const destCoords = await getCoords(destination);
    console.info("[route-optimizer] resolved coords", { originCoords, destCoords, user_id: user.id });

    // ── 1. Generate candidates ──────────────────────────────────────────
    const candidates = buildCandidates(originCoords, destCoords);

    // ── 2. Traffic conflict detection (fleet-wide — needed for safety) ──
    const { data: existingIntents } = await supabase
      .from("flight_intents")
      .select("aircraft_id, origin, destination, altitude_band, departure_window_start, departure_window_end, status, id")
      .in("status", ["analyzing", "pending", "approved", "active"])
      .neq("id", flight_intent_id ?? "00000000-0000-0000-0000-000000000000")
      .order("created_at", { ascending: false })
      .limit(100);

    const conflicts: ConflictEntry[] = [];
    let conflictDensity = 0;
    for (const intent of existingIntents ?? []) {
      if (!windowsOverlap(departure_window_start ?? "00:00", departure_window_end ?? "23:59", intent.departure_window_start, intent.departure_window_end)) continue;
      const iOrigin = await getCoords(intent.origin);
      const iDest = await getCoords(intent.destination);
      const nearOrigin = haversine(originCoords[0], originCoords[1], iOrigin[0], iOrigin[1]) < 20;
      const nearDest = haversine(destCoords[0], destCoords[1], iDest[0], iDest[1]) < 20;
      if (!nearOrigin && !nearDest) continue;
      const severity: ConflictEntry["severity"] = nearOrigin && nearDest ? "high" : "moderate";
      conflicts.push({ aircraft_id: intent.aircraft_id, conflict_type: severity === "high" ? "Overlapping departure window with shared origin & destination" : "Overlapping departure window with nearby origin or destination", severity });
      conflictDensity += severity === "high" ? 0.6 : 0.3;
    }

    // ── 3. Load active no-fly zones for spatial filtering ───────────────
    const { data: noFlySegments } = await supabase
      .from("airspace_segments")
      .select("name, boundary_polygon")
      .eq("is_no_fly", true)
      .not("boundary_polygon", "is", null);
    const noFlyZones = (noFlySegments ?? []).filter(s => s.boundary_polygon);

    // ── 4. Evaluate candidates ──────────────────────────────────────────
    const wxCache = new WxCache();
    const evals = await Promise.all(candidates.map((c) => evaluateRoute(c.waypoints, wxCache, conflictDensity)));
    const fastestTime = Math.min(...evals.map((e) => e.timeMin));
    const shortestDist = Math.min(...evals.map((e) => e.distanceKm));

    // ── 5. Load scoring weights ─────────────────────────────────────────
    let weights: ScoreWeights = { ...DEFAULT_WEIGHTS };
    const { data: cfg } = await supabase
      .from("route_score_config")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();
    if (cfg) {
      weights = {
        weight_safety: Number(cfg.weight_safety ?? DEFAULT_WEIGHTS.weight_safety),
        weight_weather: Number(cfg.weight_weather ?? DEFAULT_WEIGHTS.weight_weather),
        weight_traffic: Number(cfg.weight_traffic ?? DEFAULT_WEIGHTS.weight_traffic),
        weight_efficiency: Number(cfg.weight_efficiency ?? DEFAULT_WEIGHTS.weight_efficiency),
        weight_time: Number(cfg.weight_time ?? DEFAULT_WEIGHTS.weight_time),
        weight_fuel: Number(cfg.weight_fuel ?? DEFAULT_WEIGHTS.weight_fuel),
      };
    }

    // ── 6. Historical bias — user-specific first, fleet fallback ────────
    const originKey = origin.toLowerCase().split("@")[0].trim();
    const destKey = destination.toLowerCase().split("@")[0].trim();

    let pattern = null;
    const { data: userPattern } = await supabase
      .from("route_patterns").select("*")
      .eq("origin_key", originKey).eq("destination_key", destKey).eq("user_id", user.id)
      .maybeSingle();
    pattern = userPattern;

    if (!pattern) {
      const { data: fleetPattern } = await supabase
        .from("route_patterns").select("*")
        .eq("origin_key", originKey).eq("destination_key", destKey).is("user_id", null)
        .maybeSingle();
      pattern = fleetPattern;
    }

    // ── 7. Score, apply no-fly penalty, apply historical drift ──────────
    const scored = candidates.map((c, i) => {
      const score = scoreEval(evals[i], fastestTime, shortestDist, weights);
      let overall = score.overall;

      // Heavy penalty for routes passing through active no-fly zones.
      const violatedZone = noFlyZones.length > 0 ? routeIntersectsNoFly(c.waypoints, noFlyZones) : null;
      if (violatedZone) overall = Math.max(0, overall - 50);

      // Historical drift adjustment (user-specific or fleet).
      if (pattern && (pattern.completed_flight_count ?? 0) >= 2) {
        const predicted = Number(pattern.avg_overall_score ?? 70);
        const adjusted = Number(pattern.outcome_adjusted_score ?? predicted);
        const drift = adjusted - predicted;
        overall = Math.max(10, Math.min(100, overall + drift * 0.3));
      }

      return {
        candidate: c,
        evaluation: evals[i],
        score: { ...score, overall: Math.round(overall) },
        distance_km: Math.round(evals[i].distanceKm * 10) / 10,
        estimated_time_min: Math.round(evals[i].timeMin * 10) / 10,
        violated_no_fly_zone: violatedZone,
        wind_drift: computeWindDrift(evals[i]),
      };
    });

    scored.sort((a, b) => b.score.overall - a.score.overall);
    const top3 = scored.slice(0, 3);

    const buildOperationalNote = (s: typeof top3[number]): string => {
      const e = s.evaluation;
      const bits: string[] = [];
      if (s.violated_no_fly_zone) bits.push(`⚠ Passes through restricted zone: ${s.violated_no_fly_zone}`);
      if (e.avgHeadwindKmh > 8) bits.push(`headwind ~${Math.round(e.avgHeadwindKmh)} km/h`);
      else if (e.avgHeadwindKmh < -8) bits.push(`tailwind ~${Math.round(-e.avgHeadwindKmh)} km/h`);
      if (e.avgCrosswindKmh > 15) bits.push(`crosswind ~${Math.round(e.avgCrosswindKmh)} km/h`);
      if (e.maxTurbulence > 0.5) bits.push("turbulence likely");
      if (e.avgIcing > 0.2) bits.push("icing possible");
      if (e.avgWxSeverity > 0.4) bits.push("weather elevated");
      if (e.avgVisibilityM < 5000) bits.push("reduced visibility");
      return bits.length ? bits.join(" · ") : "Clear conditions along route.";
    };

    const routes = top3.map((s, rank) => ({
      id: s.candidate.id,
      label: s.candidate.label,
      rank: rank + 1,
      waypoints: s.candidate.waypoints.map(([lat, lon]) => ({ lat, lon })),
      distance_km: s.distance_km,
      estimated_time_min: s.estimated_time_min,
      overall_score: s.score.overall,
      safety_score: s.score.safety,
      weather_score: s.score.weather,
      traffic_score: s.score.traffic,
      efficiency_score: s.score.efficiency,
      time_score: s.score.time,
      wind_score: s.score.wind,
      turbulence_score: s.score.turbulence,
      fuel_score: s.score.fuel,
      wind_drift: s.wind_drift,
      violated_no_fly_zone: s.violated_no_fly_zone,
      wind_summary: {
        avg_headwind_kmh: Math.round(s.evaluation.avgHeadwindKmh),
        avg_crosswind_kmh: Math.round(s.evaluation.avgCrosswindKmh),
      },
      hazards: {
        turbulence_probability: Math.round(s.evaluation.maxTurbulence * 100),
        icing_probability: Math.round(s.evaluation.avgIcing * 100),
        worst_weather_code: s.evaluation.worstWeatherCode,
        min_visibility_m: Math.round(s.evaluation.avgVisibilityM),
      },
      operational_note: buildOperationalNote(s),
      is_selected: false,
    }));

    const primaryRoute = { ...routes[0], is_selected: true };
    const alternateRoutes = routes.slice(1);

    // ── 8. Persist route with user_id ───────────────────────────────────
    const weatherConditions = await wxCache.get(originCoords[0], originCoords[1]);
    const overallWxSeverity = top3[0]?.evaluation.avgWxSeverity ?? 0;
    const weatherRisk: "low" | "moderate" | "high" =
      overallWxSeverity >= 0.5 ? "high" : overallWxSeverity >= 0.25 ? "moderate" : "low";

    const { data: savedRoute } = await supabase
      .from("routes")
      .insert({
        flight_intent_id: flight_intent_id ?? null,
        aircraft_id,
        operator_name,
        origin,
        destination,
        altitude_band,
        primary_route: primaryRoute,
        alternate_routes: alternateRoutes,
        overall_score: primaryRoute.overall_score,
        safety_score: primaryRoute.safety_score,
        weather_score: primaryRoute.weather_score,
        traffic_score: primaryRoute.traffic_score,
        efficiency_score: primaryRoute.efficiency_score,
        conflict_details: conflicts,
        weather_conditions: {
          wind_speed: weatherConditions.windSpeedKmh,
          wind_direction_deg: weatherConditions.windFromDeg,
          wind_gusts: weatherConditions.windGustsKmh,
          precipitation: weatherConditions.precipitationMm,
          temperature: weatherConditions.temperatureC,
          weather_code: weatherConditions.weatherCode,
          visibility: weatherConditions.visibilityM,
        },
        weather_risk: weatherRisk,
        selection_reason: primaryRoute.operational_note,
        status: "active",
      })
      .select("id")
      .single();

    // ── 9. Upsert both user-specific and fleet route_patterns ────────────
    const patternUpsert = async (uid: string | null, existing: any) => {
      const n = (existing?.flight_count ?? 0) + 1;
      const blend = (oldVal: number | null, fresh: number) =>
        ((Number(oldVal ?? fresh) * (existing?.flight_count ?? 0)) + fresh) / n;
      const data = {
        origin_key: originKey,
        destination_key: destKey,
        altitude_band,
        user_id: uid,
        flight_count: n,
        avg_overall_score: blend(existing?.avg_overall_score, primaryRoute.overall_score),
        avg_safety_score: blend(existing?.avg_safety_score, primaryRoute.safety_score),
        avg_weather_score: blend(existing?.avg_weather_score, primaryRoute.weather_score),
        avg_traffic_score: blend(existing?.avg_traffic_score, primaryRoute.traffic_score),
        avg_efficiency_score: blend(existing?.avg_efficiency_score, primaryRoute.efficiency_score),
        preferred_waypoints: primaryRoute.waypoints,
        last_updated: new Date().toISOString(),
      };
      if (existing) {
        await supabase.from("route_patterns").update(data).eq("id", existing.id);
      } else {
        await supabase.from("route_patterns").insert({ ...data, flight_count: 1 });
      }
    };

    await patternUpsert(user.id, userPattern ?? null);

    const { data: fleetPattern } = await supabase
      .from("route_patterns").select("*")
      .eq("origin_key", originKey).eq("destination_key", destKey).is("user_id", null)
      .maybeSingle();
    await patternUpsert(null, fleetPattern ?? null);

    const historicalSuggestion = pattern && pattern.flight_count >= 2
      ? {
          found: true,
          is_user_specific: pattern.user_id != null,
          flight_count: pattern.flight_count,
          completed_flight_count: pattern.completed_flight_count ?? 0,
          avg_score: Math.round(Number(pattern.avg_overall_score ?? 0)),
          outcome_adjusted_score: pattern.outcome_adjusted_score ? Math.round(Number(pattern.outcome_adjusted_score)) : null,
          message: (pattern.completed_flight_count ?? 0) >= 2
            ? `Flown ${pattern.flight_count} times · ${pattern.completed_flight_count} completed. Outcome-adjusted: ${Math.round(Number(pattern.outcome_adjusted_score ?? pattern.avg_overall_score))}.`
            : `Flown ${pattern.flight_count} times. Avg planning score: ${Math.round(Number(pattern.avg_overall_score ?? 0))}.`,
        }
      : { found: false };

    return json({
      route_id: savedRoute?.id ?? crypto.randomUUID(),
      top_routes: routes,
      primary_route: primaryRoute,
      alternate_routes: alternateRoutes,
      conflict_details: conflicts,
      weather_conditions: {
        wind_speed: Math.round(weatherConditions.windSpeedKmh),
        wind_direction_deg: Math.round(weatherConditions.windFromDeg),
        wind_gusts: Math.round(weatherConditions.windGustsKmh),
        precipitation: weatherConditions.precipitationMm,
        temperature: Math.round(weatherConditions.temperatureC),
        weather_code: weatherConditions.weatherCode,
        visibility: Math.round(weatherConditions.visibilityM),
      },
      weather_risk: weatherRisk,
      historical_suggestion: historicalSuggestion,
      analysis_summary: {
        total_conflicts: conflicts.length,
        routes_evaluated: candidates.length,
        routes_returned: routes.length,
        no_fly_zones_checked: noFlyZones.length,
        optimization_method: "Dynamic candidate generation with multi-axis scoring (time / wind / weather / turbulence / fuel / traffic / safety / airspace)",
        scoring_weights: weights,
      },
    });
  } catch (error: unknown) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : String(error);
    console.error("Route optimizer error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
