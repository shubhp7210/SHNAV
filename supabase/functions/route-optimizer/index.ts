// Route optimizer — generates multiple candidate routes, scores them on
// time / wind / weather / turbulence / fuel / traffic / safety, and returns
// the top 3. Weights are pulled from route_score_config so the learning loop
// can adjust them from actual outcomes.
import { EVTOL_BASE_SPEED_KMH } from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { serve, httpError } from "../_shared/http.ts";
import { readBody, validateFields } from "../_shared/validate.ts";
import { checkNetwork, type Conflict } from "../_shared/conflicts.ts";
import { loadTraffic, trackFromRow } from "../_shared/traffic.ts";
import { trafficLabel } from "../_shared/anonymize.ts";
import {
  bearingDeg,
  haversineKm as haversine,
  type LatLon,
  windRelativeToHeading,
} from "../_shared/geo.ts";

/** Human-readable conflict label with the supporting separation + timing facts. */
function conflictLabel(c: Conflict): string {
  const kind: Record<Conflict["type"], string> = {
    crossing: "Crossing route",
    converging: "Converging route",
    "shared-corridor": "Shared corridor",
    parallel: "Near-parallel route",
    "approach-proximity": "Vertiport/approach proximity",
  };
  return `${kind[c.type]} · ${c.horizontalSepKm.toFixed(2)} km sep · ${c.timeOverlapMin} min window (±${c.uncertaintyMin} min)`;
}
import {
  icingFromWeather,
  turbulenceFromGustCross,
  weatherSeverity,
  WxCache,
} from "../_shared/weather.ts";

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
  const samplePts = samplePointsAlongRoute(waypoints, 12);
  for (const zone of noFlyZones) {
    if (!zone.boundary_polygon || zone.boundary_polygon.length < 3) continue;
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
  minVisibilityM: number;
  worstWeatherCode: number;
  trafficPenalty: number;
  /** Weather samples that actually returned forecast data. */
  wxAvailable: number;
  wxTotal: number;
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

  let sumHead = 0, sumCross = 0, sumWxSev = 0, maxWxSev = 0, sumTurb = 0, maxTurb = 0, sumIcing = 0, sumVis = 0, minVis = Infinity, worstWxCode = 0;
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
    if (wx.visibilityM < minVis) minVis = wx.visibilityM;
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
    minVisibilityM: Number.isFinite(minVis) ? minVis : 10000,
    worstWeatherCode: worstWxCode,
    trafficPenalty: conflictDensity,
    wxAvailable: wxList.filter((w) => w.available).length,
    wxTotal: wxList.length,
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

/** Clamp a score into the valid 0–100 band so no displayed metric can exceed 100. */
const clampScore = (n: number): number => Math.max(0, Math.min(100, n));

function scoreEval(ev: RouteEval, fastestTimeMin: number, shortestDistKm: number, weights: ScoreWeights) {
  const timeDelta = Math.max(0, ev.timeMin - fastestTimeMin);
  const timeScore = clampScore(Math.max(10, 100 - (timeDelta / Math.max(1, fastestTimeMin)) * 120));
  const windScore = clampScore(Math.max(10, 60 - ev.avgHeadwindKmh * 1.2 - ev.avgCrosswindKmh * 0.5 + 40));
  const wxScore = clampScore(Math.max(10, 100 - ev.avgWxSeverity * 80 - ev.maxWxSeverity * 20));
  const turbScore = clampScore(Math.max(10, 100 - ev.avgTurbulence * 70 - ev.maxTurbulence * 30));
  const fuelRatio = ev.timeMin / Math.max(1, ev.baseTimeMin);
  // A tailwind can make a route faster than the no-wind baseline (fuelRatio < 1),
  // which would push this above 100 — clampScore keeps it in band.
  const fuelScore = clampScore(Math.max(10, 100 - (fuelRatio - 1) * 180));
  const trafScore = clampScore(Math.max(10, 100 - Math.min(5, ev.trafficPenalty) * 16));
  const distRatio = ev.distanceKm / Math.max(0.01, shortestDistKm);
  const effScore = clampScore(Math.max(10, 100 - (distRatio - 1) * 140 - ev.avgIcing * 30));
  const visPenalty = ev.avgVisibilityM < 5000 ? (5000 - ev.avgVisibilityM) / 50 : 0;
  const safetyScore = clampScore(Math.max(10, 100 - ev.maxWxSeverity * 35 - ev.maxTurbulence * 25 - ev.avgIcing * 25 - visPenalty));
  const w = weights;
  const overall = clampScore(
    safetyScore * w.weight_safety + wxScore * w.weight_weather + trafScore * w.weight_traffic +
    effScore * w.weight_efficiency + timeScore * w.weight_time + fuelScore * w.weight_fuel,
  );
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same normalisation as SQL od_key(): place name before the "@ lat,lon" tag. */
const odKey = (s: string) => s.toLowerCase().split("@")[0].trim();

serve("route-optimizer", async ({ req, admin: supabase, json, cors: corsHeaders, setUser }) => {
    const user = await requireUserAuth(req);
    setUser(user.id);

    const rl = await checkRateLimit(supabase, user.id, "route-optimizer", 30, 60);
    if (!rl.allowed) return tooManyRequests(corsHeaders, rl.windowSeconds);

    const { flight_intent_id } = validateFields(await readBody(req), {
      flight_intent_id: { required: true, type: "string", maxLength: 36, pattern: UUID },
    }) as { flight_intent_id: string };

    // Everything comes from the stored, owned intent (server truth).
    const { data: fi } = await supabase.from("flight_intents")
      .select("id, aircraft_id, operator_name, origin, destination, altitude_band, departure_start_at, departure_end_at, origin_lat, origin_lon, dest_lat, dest_lon, status")
      .eq("id", flight_intent_id).eq("user_id", user.id).maybeSingle();
    if (!fi) throw httpError(403, "Flight intent not found or access denied");
    if (fi.origin_lat == null || fi.dest_lat == null) {
      throw httpError(422, "Origin or destination could not be located — pick locations from the search results");
    }
    if (!fi.departure_start_at || !fi.departure_end_at) throw httpError(422, "Flight intent has no departure time — refile the flight");
    const { aircraft_id, operator_name, origin, destination } = fi;
    const band: string = fi.altitude_band ?? "low";
    const departureStart = new Date(fi.departure_start_at);
    const departureEnd = new Date(fi.departure_end_at);
    const originCoords: LatLon = [fi.origin_lat, fi.origin_lon];
    const destCoords: LatLon = [fi.dest_lat, fi.dest_lon];

    // ── 1. Generate candidates ──────────────────────────────────────────
    const candidates = buildCandidates(originCoords, destCoords);

    // ── 2. Traffic conflicts (fleet-wide, absolute time, stored coords) ──
    const traffic = await loadTraffic(supabase, { start: departureStart, end: departureEnd, excludeId: fi.id });
    const candidateTrack = trackFromRow({ ...fi, user_id: user.id });
    const otherTracks = traffic.map((r) => trackFromRow(r, r.user_id === user.id ? r.aircraft_id : trafficLabel(r.id)));
    const conflictResult = checkNetwork(candidateTrack, otherTracks);
    const conflicts: ConflictEntry[] = conflictResult.conflicts.map((c) => ({
      aircraft_id: c.otherId,
      conflict_type: conflictLabel(c),
      severity: c.severity,
    }));
    let conflictDensity = 0;
    for (const c of conflictResult.conflicts) {
      conflictDensity += c.severity === "high" ? 0.6 : c.severity === "moderate" ? 0.3 : 0.15;
    }

    // ── 3. Load active no-fly zones for spatial filtering ───────────────
    const { data: noFlySegments } = await supabase
      .from("airspace_segments")
      .select("name, boundary_polygon")
      .eq("is_no_fly", true)
      .not("boundary_polygon", "is", null);
    const noFlyZones = (noFlySegments ?? []).filter(s => s.boundary_polygon);

    // ── 4. Evaluate candidates ──────────────────────────────────────────
    const wxCache = new WxCache(departureStart);
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
    const originKey = odKey(origin);
    const destKey = odKey(destination);

    // altitude_band is part of the unique key on route_patterns — omitting it
    // makes maybeSingle() error once the same OD pair exists at two bands.
    let pattern = null;
    const { data: userPattern } = await supabase
      .from("route_patterns").select("*")
      .eq("origin_key", originKey).eq("destination_key", destKey)
      .eq("altitude_band", band).eq("user_id", user.id)
      .maybeSingle();
    pattern = userPattern;

    if (!pattern) {
      const { data: fleetPattern } = await supabase
        .from("route_patterns").select("*")
        .eq("origin_key", originKey).eq("destination_key", destKey)
        .eq("altitude_band", band).is("user_id", null)
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
        min_visibility_m: Math.round(s.evaluation.minVisibilityM),
      },
      operational_note: buildOperationalNote(s),
      is_selected: false,
    }));

    const primaryRoute = { ...routes[0], is_selected: true };
    const alternateRoutes = routes.slice(1);

    // ── 8. Persist route with user_id ───────────────────────────────────
    const weatherConditions = await wxCache.get(originCoords[0], originCoords[1]);
    const overallWxSeverity = top3[0]?.evaluation.avgWxSeverity ?? 0;
    const wxCoverage = top3[0] ? top3[0].evaluation.wxAvailable / Math.max(1, top3[0].evaluation.wxTotal) : 0;
    // Missing forecast samples are NOT treated as calm weather.
    const weatherRisk: "low" | "moderate" | "high" | "unknown" =
      !weatherConditions.available || wxCoverage < 0.5 ? "unknown"
        : overallWxSeverity >= 0.5 ? "high" : overallWxSeverity >= 0.25 ? "moderate" : "low";
    const wxOut = weatherConditions.available ? {
      wind_speed: Math.round(weatherConditions.windSpeedKmh),
      wind_direction_deg: Math.round(weatherConditions.windFromDeg),
      wind_gusts: Math.round(weatherConditions.windGustsKmh),
      precipitation: weatherConditions.precipitationMm,
      temperature: Number.isFinite(weatherConditions.temperatureC) ? Math.round(weatherConditions.temperatureC) : null,
      weather_code: weatherConditions.weatherCode,
      visibility: Number.isFinite(weatherConditions.visibilityM) ? Math.round(weatherConditions.visibilityM) : null,
      valid_at: weatherConditions.validAt,
    } : null;

    const { data: savedRoute, error: routeSaveErr } = await supabase
      .from("routes")
      .insert({
        flight_intent_id: flight_intent_id ?? null,
        aircraft_id,
        operator_name,
        origin,
        destination,
        altitude_band: band,
        primary_route: primaryRoute,
        alternate_routes: alternateRoutes,
        overall_score: primaryRoute.overall_score,
        safety_score: primaryRoute.safety_score,
        weather_score: primaryRoute.weather_score,
        traffic_score: primaryRoute.traffic_score,
        efficiency_score: primaryRoute.efficiency_score,
        conflict_details: conflicts,
        weather_conditions: wxOut,
        weather_risk: weatherRisk,
        selection_reason: primaryRoute.operational_note,
        status: "active",
      })
      .select("id")
      .single();
    // The decision engine reads this row — a missing row must fail loudly, not
    // be papered over with a random id.
    if (routeSaveErr || !savedRoute) throw new Error(`routes insert failed: ${routeSaveErr?.message ?? "no row"}`);

    // ── 9. Atomic running-average upserts (user + fleet) ─────────────────
    const patternArgs = {
      p_origin_key: originKey, p_dest_key: destKey, p_band: band,
      p_overall: primaryRoute.overall_score, p_safety: primaryRoute.safety_score,
      p_weather: primaryRoute.weather_score, p_traffic: primaryRoute.traffic_score,
      p_efficiency: primaryRoute.efficiency_score, p_waypoints: primaryRoute.waypoints,
    };
    const upserts = await Promise.all([
      supabase.rpc("upsert_route_pattern", { p_user: user.id, ...patternArgs }),
      supabase.rpc("upsert_route_pattern", { p_user: null, ...patternArgs }),
    ]);
    for (const u of upserts) if (u.error) console.error("[route-optimizer] upsert_route_pattern failed", u.error.message);

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
      route_id: savedRoute.id,
      top_routes: routes,
      primary_route: primaryRoute,
      alternate_routes: alternateRoutes,
      conflict_details: conflicts,
      weather_conditions: wxOut,
      weather_data: { available_samples: top3[0]?.evaluation.wxAvailable ?? 0, total_samples: top3[0]?.evaluation.wxTotal ?? 0, valid_for: departureStart.toISOString() },
      weather_risk: weatherRisk,
      historical_suggestion: historicalSuggestion,
      // Traceable conflict-check result (honest status: checked_clear vs
      // conflicts vs incomplete; never a fabricated "all clear").
      conflict_check: {
        status: conflictResult.status,
        evaluated_flights: conflictResult.evaluatedCount,
        skipped_flights: conflictResult.skipped.length,
        method: conflictResult.method,
        generated_at: new Date().toISOString(),
      },
      analysis_summary: {
        total_conflicts: conflicts.length,
        routes_evaluated: candidates.length,
        routes_returned: routes.length,
        no_fly_zones_checked: noFlyZones.length,
        optimization_method: "Dynamic candidate generation with multi-axis scoring (time / wind / weather / turbulence / fuel / traffic / safety / airspace)",
        scoring_weights: weights,
      },
    });
});
