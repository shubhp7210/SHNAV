// Route optimizer — generates multiple candidate routes, scores them on
// time / wind / weather / turbulence / fuel / traffic / safety, and returns
// the top 3. No route type is hardcoded; deviation directions are derived
// from the great-circle bearing so the same logic works for any OD pair.
//
// Scoring weights are pulled from route_score_config so the learning loop in
// record-flight-outcome can adjust them based on prediction error.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ──────────────────────────────────────────────────────────────────────────
// Geocoding (unchanged — tagged coord pattern + Nominatim fallback)
// ──────────────────────────────────────────────────────────────────────────
const LOCATION_COORDS: Record<string, [number, number]> = {
  "nyc": [40.7128, -74.006],
  "new york": [40.7128, -74.006],
  "manhattan": [40.776, -73.97],
  "brooklyn": [40.678, -73.944],
  "jfk": [40.641, -73.779],
  "laguardia": [40.776, -73.872],
  "newark": [40.69, -74.175],
  "los angeles": [34.052, -118.243],
  "lax": [33.942, -118.408],
  "chicago": [41.883, -87.623],
  "miami": [25.761, -80.191],
  "seattle": [47.606, -122.332],
  "boston": [42.361, -71.057],
  "dallas": [32.776, -96.797],
  "denver": [39.739, -104.99],
  "san francisco": [37.774, -122.419],
  "default": [40.7128, -74.006],
};

function parseTaggedCoords(location: string): [number, number] | null {
  const tagged = location.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (tagged) {
    const lat = parseFloat(tagged[1]);
    const lon = parseFloat(tagged[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }
  const bare = location.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lon = parseFloat(bare[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }
  return null;
}

async function getCoords(location: string): Promise<[number, number]> {
  if (!location?.trim()) return LOCATION_COORDS["default"];
  const parsed = parseTaggedCoords(location);
  if (parsed) return parsed;
  const key = location.toLowerCase().trim();
  for (const [known, coords] of Object.entries(LOCATION_COORDS)) {
    if (known !== "default" && key.includes(known)) return coords;
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
      { headers: { "User-Agent": "Altos-ATM/1.0", "Accept-Language": "en" } }
    );
    const arr = await res.json();
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
      return [parseFloat(arr[0].lat), parseFloat(arr[0].lon)];
    }
  } catch (error) {
    console.error("Route optimizer geocode failed:", error);
  }
  return LOCATION_COORDS["default"];
}

// ──────────────────────────────────────────────────────────────────────────
// Geometry & meteo helpers
// ──────────────────────────────────────────────────────────────────────────
const KM_PER_DEG_LAT = 111.32;
const EVTOL_BASE_SPEED_KMH = 90;

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bearing from (lat1,lon1) to (lat2,lon2) in degrees [0, 360).
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Resolve wind components relative to the aircraft heading.
// Returns headwind (kmh; negative = tailwind) and absolute crosswind (kmh).
// `windFrom` is the meteorological "wind from" direction (where it blows from).
function windRelativeToHeading(
  headingDeg: number,
  windFromDeg: number,
  windSpeedKmh: number
): { headwindKmh: number; crosswindKmh: number } {
  // Convert "wind from" to "wind to" (vector direction the air is moving).
  const windToDeg = (windFromDeg + 180) % 360;
  // Angle between aircraft heading and wind vector. 0° = perfect tailwind.
  const relDeg = ((windToDeg - headingDeg + 540) % 360) - 180; // [-180, 180]
  const relRad = (relDeg * Math.PI) / 180;
  const tailwindComponent = Math.cos(relRad) * windSpeedKmh; // + = tailwind
  const crosswindComponent = Math.sin(relRad) * windSpeedKmh;
  return {
    headwindKmh: -tailwindComponent, // positive = slowing us down
    crosswindKmh: Math.abs(crosswindComponent),
  };
}

interface WeatherSample {
  windSpeedKmh: number;
  windFromDeg: number;
  windGustsKmh: number;
  precipitationMm: number;
  temperatureC: number;
  weatherCode: number;
  visibilityM: number;
}

const NEUTRAL_WX: WeatherSample = {
  windSpeedKmh: 5,
  windFromDeg: 0,
  windGustsKmh: 7,
  precipitationMm: 0,
  temperatureC: 18,
  weatherCode: 0,
  visibilityM: 10000,
};

async function fetchWeather(lat: number, lon: number): Promise<WeatherSample> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,visibility,weather_code&wind_speed_unit=kmh&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return { ...NEUTRAL_WX };
    const json = await res.json();
    const c = json?.current ?? {};
    return {
      windSpeedKmh: Number.isFinite(c.wind_speed_10m) ? c.wind_speed_10m : 5,
      windFromDeg: Number.isFinite(c.wind_direction_10m) ? c.wind_direction_10m : 0,
      windGustsKmh: Number.isFinite(c.wind_gusts_10m) ? c.wind_gusts_10m : 7,
      precipitationMm: Number.isFinite(c.precipitation) ? c.precipitation : 0,
      temperatureC: Number.isFinite(c.temperature_2m) ? c.temperature_2m : 18,
      weatherCode: Number.isFinite(c.weather_code) ? c.weather_code : 0,
      visibilityM: Number.isFinite(c.visibility) ? c.visibility : 10000,
    };
  } catch {
    return { ...NEUTRAL_WX };
  }
}

// Per-leg weather severity (0 = perfect, 1 = unflyable). Combines wind, gusts,
// precip, and weather-code into a single normalized cost.
function weatherSeverity(wx: WeatherSample): number {
  let s = 0;
  if (wx.windSpeedKmh > 60) s += 0.5;
  else if (wx.windSpeedKmh > 40) s += 0.3;
  else if (wx.windSpeedKmh > 25) s += 0.15;
  if (wx.windGustsKmh > 70) s += 0.4;
  else if (wx.windGustsKmh > 45) s += 0.2;
  else if (wx.windGustsKmh > 30) s += 0.1;
  if (wx.precipitationMm > 5) s += 0.3;
  else if (wx.precipitationMm > 1) s += 0.15;
  else if (wx.precipitationMm > 0.2) s += 0.05;
  if (wx.weatherCode >= 95) s += 0.6; // thunderstorm
  else if (wx.weatherCode >= 71) s += 0.3; // snow
  else if (wx.weatherCode >= 61) s += 0.15; // rain
  else if (wx.weatherCode >= 51) s += 0.06; // drizzle
  if (wx.visibilityM < 3000) s += 0.3;
  else if (wx.visibilityM < 6000) s += 0.1;
  return Math.min(1, s);
}

// Probability proxy for turbulence: built from gusts + crosswind.
// Capped 0..1.
function turbulenceFromGustCross(gustsKmh: number, crosswindKmh: number): number {
  const g = Math.min(1, gustsKmh / 70);
  const c = Math.min(1, crosswindKmh / 30);
  return Math.min(1, g * 0.55 + c * 0.65);
}

// Probability proxy for icing conditions: cold + precipitation + cloud-coded.
function icingFromWeather(wx: WeatherSample): number {
  if (wx.temperatureC > 4) return 0;
  let p = 0;
  if (wx.temperatureC <= -2 && wx.precipitationMm > 0) p += 0.6;
  else if (wx.temperatureC <= 2 && wx.precipitationMm > 0) p += 0.35;
  if (wx.weatherCode >= 56 && wx.weatherCode <= 67) p += 0.2; // freezing rain codes
  return Math.min(1, p);
}

// ──────────────────────────────────────────────────────────────────────────
// Route geometry — produce a polyline with N evenly spaced waypoints
// ──────────────────────────────────────────────────────────────────────────
type LatLon = [number, number];

function directRoute(o: LatLon, d: LatLon, n: number): LatLon[] {
  const pts: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([o[0] + (d[0] - o[0]) * t, o[1] + (d[1] - o[1]) * t]);
  }
  return pts;
}

// Build a curved route offset perpendicular to the great-circle direction.
// `offsetKm` is the maximum perpendicular displacement at the midpoint.
// Positive offset = left of the direction of travel, negative = right.
function deviationRoute(o: LatLon, d: LatLon, offsetKm: number, n = 24): LatLon[] {
  const [oLat, oLon] = o;
  const [dLat, dLon] = d;
  const bearing = bearingDeg(oLat, oLon, dLat, dLon);
  // Perpendicular bearing (90° to the left of direction of travel).
  const perpBearing = (bearing - 90 + 360) % 360;
  const perpRad = (perpBearing * Math.PI) / 180;
  const dLatPerKm = 1 / KM_PER_DEG_LAT;
  const midLat = (oLat + dLat) / 2;
  const dLonPerKm = 1 / (KM_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180) || 1e-6);
  // Convert (offset, perpBearing) into degrees of lat/lon at the midpoint.
  const perpLat = Math.cos(perpRad) * dLatPerKm;
  const perpLon = Math.sin(perpRad) * dLonPerKm;

  const pts: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const baseLat = oLat + (dLat - oLat) * t;
    const baseLon = oLon + (dLon - oLon) * t;
    // sin(πt) gives a smooth curve peaking at t=0.5 and returning to 0 at endpoints.
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

// Sample weather at K evenly spaced points along the route. K kept small to
// stay within Open-Meteo rate limits — we batch all candidates' samples through
// a shared cache keyed by ~5km grid cells.
function samplePointsAlongRoute(pts: LatLon[], k: number): LatLon[] {
  if (k <= 0 || pts.length < 2) return [];
  const out: LatLon[] = [];
  for (let i = 0; i < k; i++) {
    const t = i / (k - 1);
    const target = t * (pts.length - 1);
    const lo = Math.floor(target);
    const hi = Math.min(pts.length - 1, lo + 1);
    const frac = target - lo;
    out.push([
      pts[lo][0] + (pts[hi][0] - pts[lo][0]) * frac,
      pts[lo][1] + (pts[hi][1] - pts[lo][1]) * frac,
    ]);
  }
  return out;
}

interface WxCacheEntry {
  wx: WeatherSample;
  ts: number;
}
class WxCache {
  private map = new Map<string, Promise<WeatherSample>>();
  private resolved = new Map<string, WxCacheEntry>();
  private readonly TTL_MS = 5 * 60 * 1000;

  private key(lat: number, lon: number): string {
    // ~5 km cells at mid latitudes.
    return `${Math.round(lat * 20) / 20},${Math.round(lon * 20) / 20}`;
  }

  async get(lat: number, lon: number): Promise<WeatherSample> {
    const k = this.key(lat, lon);
    const cached = this.resolved.get(k);
    if (cached && Date.now() - cached.ts < this.TTL_MS) return cached.wx;
    const existing = this.map.get(k);
    if (existing) return existing;
    const p = fetchWeather(lat, lon).then((wx) => {
      this.resolved.set(k, { wx, ts: Date.now() });
      this.map.delete(k);
      return wx;
    });
    this.map.set(k, p);
    return p;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Per-route evaluation — produces all the numbers we need to score it
// ──────────────────────────────────────────────────────────────────────────
interface RouteEval {
  distanceKm: number;
  timeMin: number;             // wind-adjusted flight time
  baseTimeMin: number;         // distance / base speed (no wind)
  avgHeadwindKmh: number;
  avgCrosswindKmh: number;
  avgWxSeverity: number;       // [0..1]
  maxWxSeverity: number;       // [0..1]
  avgTurbulence: number;       // [0..1]
  maxTurbulence: number;       // [0..1]
  avgIcing: number;            // [0..1]
  avgVisibilityM: number;
  worstWeatherCode: number;
  trafficPenalty: number;      // unnormalized count-ish
}

async function evaluateRoute(
  waypoints: LatLon[],
  wxCache: WxCache,
  conflictDensity: number,
  sampleCount = 6
): Promise<RouteEval> {
  const distanceKm = routeDistance(waypoints);
  const samples = samplePointsAlongRoute(waypoints, sampleCount);
  const wxList = await Promise.all(samples.map((p) => wxCache.get(p[0], p[1])));

  // Per-leg bearings to compute wind components on each leg.
  const bearings: number[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    bearings.push(bearingDeg(waypoints[i - 1][0], waypoints[i - 1][1], waypoints[i][0], waypoints[i][1]));
  }
  // Aggregate per-sample wind effect against the nearest leg.
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
  const avgHead = sumHead / n;
  const avgCross = sumCross / n;
  const avgWxSev = sumWxSev / n;
  const avgTurb = sumTurb / n;
  const avgIcing = sumIcing / n;
  const avgVis = sumVis / n;

  // Effective ground speed = base airspeed minus headwind component (cap to floor).
  const effectiveSpeed = Math.max(40, EVTOL_BASE_SPEED_KMH - avgHead);
  const timeMin = (distanceKm / effectiveSpeed) * 60;
  const baseTimeMin = (distanceKm / EVTOL_BASE_SPEED_KMH) * 60;

  return {
    distanceKm,
    timeMin,
    baseTimeMin,
    avgHeadwindKmh: avgHead,
    avgCrosswindKmh: avgCross,
    avgWxSeverity: avgWxSev,
    maxWxSeverity: maxWxSev,
    avgTurbulence: avgTurb,
    maxTurbulence: maxTurb,
    avgIcing: avgIcing,
    avgVisibilityM: avgVis,
    worstWeatherCode: worstWxCode,
    trafficPenalty: conflictDensity,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Scoring — returns 0..100 for each axis plus the overall.
// Weights come from route_score_config when present (learning loop tunes them).
// ──────────────────────────────────────────────────────────────────────────
interface ScoreWeights {
  weight_safety: number;
  weight_weather: number;
  weight_traffic: number;
  weight_efficiency: number;
  weight_time: number;
  weight_fuel: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = {
  weight_safety: 0.22,
  weight_weather: 0.18,
  weight_traffic: 0.15,
  weight_efficiency: 0.15,
  weight_time: 0.20,
  weight_fuel: 0.10,
};

function scoreEval(
  ev: RouteEval,
  fastestTimeMin: number,
  shortestDistKm: number,
  weights: ScoreWeights
): {
  overall: number;
  time: number;
  wind: number;
  weather: number;
  turbulence: number;
  fuel: number;
  traffic: number;
  safety: number;
  efficiency: number;
} {
  // Time: 100 if this is the fastest, drops as the route takes longer.
  const timeDelta = Math.max(0, ev.timeMin - fastestTimeMin);
  const timeScore = Math.max(10, 100 - (timeDelta / Math.max(1, fastestTimeMin)) * 120);
  // Wind: tailwind boosts the score, headwind drags it down (≤ 35 kmh swing).
  const windScore = Math.max(10, Math.min(100, 60 - ev.avgHeadwindKmh * 1.2 - ev.avgCrosswindKmh * 0.5 + 40));
  // Weather: average severity drives the cost, with max severity adding a tail penalty.
  const wxScore = Math.max(10, 100 - ev.avgWxSeverity * 80 - ev.maxWxSeverity * 20);
  // Turbulence:
  const turbScore = Math.max(10, 100 - ev.avgTurbulence * 70 - ev.maxTurbulence * 30);
  // Fuel: longer distance + persistent headwind = more energy. eVTOL energy is
  // dominated by hover/cruise time; we proxy with adjusted time.
  const fuelRatio = ev.timeMin / Math.max(1, ev.baseTimeMin);
  const fuelScore = Math.max(10, 100 - (fuelRatio - 1) * 180);
  // Traffic: density-driven, capped at 0..5.
  const trafScore = Math.max(10, 100 - Math.min(5, ev.trafficPenalty) * 16);
  // Efficiency: distance vs shortest, plus icing penalty (icing forces deviations).
  const distRatio = ev.distanceKm / Math.max(0.01, shortestDistKm);
  const effScore = Math.max(10, 100 - (distRatio - 1) * 140 - ev.avgIcing * 30);
  // Safety: combination of weather extremes + turbulence + icing + low visibility.
  const visPenalty = ev.avgVisibilityM < 5000 ? (5000 - ev.avgVisibilityM) / 50 : 0;
  const safetyScore = Math.max(
    10,
    100 - ev.maxWxSeverity * 35 - ev.maxTurbulence * 25 - ev.avgIcing * 25 - visPenalty
  );

  const w = weights;
  const overall =
    safetyScore * w.weight_safety +
    wxScore * w.weight_weather +
    trafScore * w.weight_traffic +
    effScore * w.weight_efficiency +
    timeScore * w.weight_time +
    fuelScore * w.weight_fuel;

  const round = (n: number) => Math.round(n);
  return {
    overall: round(overall),
    time: round(timeScore),
    wind: round(windScore),
    weather: round(wxScore),
    turbulence: round(turbScore),
    fuel: round(fuelScore),
    traffic: round(trafScore),
    safety: round(safetyScore),
    efficiency: round(effScore),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Candidate generation
// ──────────────────────────────────────────────────────────────────────────
interface Candidate {
  id: string;
  label: string;
  waypoints: LatLon[];
}

function buildCandidates(o: LatLon, d: LatLon): Candidate[] {
  const distKm = haversine(o[0], o[1], d[0], d[1]);
  // Deviation magnitudes scale with distance so short hops don't bulge wildly.
  const small = Math.max(2, distKm * 0.06);
  const large = Math.max(5, distKm * 0.15);
  // Sign convention here matches deviationRoute: + = left of travel (port),
  // - = right of travel (starboard). We give them neutral labels.
  return [
    { id: "direct",           label: "Direct route",           waypoints: directRoute(o, d, 24) },
    { id: "port-shallow",     label: "Port deviation (small)", waypoints: deviationRoute(o, d, +small) },
    { id: "starboard-shallow",label: "Starboard deviation (small)", waypoints: deviationRoute(o, d, -small) },
    { id: "port-wide",        label: "Port deviation (wide)",  waypoints: deviationRoute(o, d, +large) },
    { id: "starboard-wide",   label: "Starboard deviation (wide)", waypoints: deviationRoute(o, d, -large) },
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// Traffic conflict detection (kept simple: how many active intents intersect
// near this route's origin or destination during overlapping time windows?)
// ──────────────────────────────────────────────────────────────────────────
function timeToMinutes(t: string): number {
  const [h, m] = (t ?? "00:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function windowsOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return timeToMinutes(s1) < timeToMinutes(e2) && timeToMinutes(s2) < timeToMinutes(e1);
}

interface ConflictEntry {
  aircraft_id: string;
  conflict_type: string;
  severity: "high" | "moderate" | "low";
}

// ──────────────────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    const {
      aircraft_id,
      operator_name,
      origin,
      destination,
      altitude_band,
      departure_window_start,
      departure_window_end,
      flight_intent_id,
    } = body;

    if (!origin || !destination) {
      return json({ error: "origin and destination are required" }, 400);
    }

    const originCoords = await getCoords(origin);
    const destCoords = await getCoords(destination);
    console.info("[route-optimizer] resolved coords", { originCoords, destCoords });

    // ── 1. Generate candidates ─────────────────────────────────────────
    const candidates = buildCandidates(originCoords, destCoords);

    // ── 2. Traffic conflict detection ──────────────────────────────────
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
      if (
        !windowsOverlap(
          departure_window_start ?? "00:00",
          departure_window_end ?? "23:59",
          intent.departure_window_start,
          intent.departure_window_end
        )
      ) continue;
      const iOrigin = await getCoords(intent.origin);
      const iDest = await getCoords(intent.destination);
      const nearOrigin = haversine(originCoords[0], originCoords[1], iOrigin[0], iOrigin[1]) < 20;
      const nearDest = haversine(destCoords[0], destCoords[1], iDest[0], iDest[1]) < 20;
      if (!nearOrigin && !nearDest) continue;
      const severity: ConflictEntry["severity"] =
        nearOrigin && nearDest ? "high" : "moderate";
      conflicts.push({
        aircraft_id: intent.aircraft_id,
        conflict_type:
          severity === "high"
            ? "Overlapping departure window with shared origin & destination"
            : "Overlapping departure window with nearby origin or destination",
        severity,
      });
      conflictDensity += severity === "high" ? 0.6 : 0.3;
    }

    // ── 3. Evaluate every candidate (parallel weather sampling via cache) ─
    const wxCache = new WxCache();
    const evals = await Promise.all(
      candidates.map((c) => evaluateRoute(c.waypoints, wxCache, conflictDensity))
    );
    const fastestTime = Math.min(...evals.map((e) => e.timeMin));
    const shortestDist = Math.min(...evals.map((e) => e.distanceKm));

    // ── 4. Load scoring weights (learning loop tunes these) ─────────────
    let weights: ScoreWeights = { ...DEFAULT_WEIGHTS };
    const { data: cfg } = await supabase
      .from("route_score_config")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();
    if (cfg) {
      // Read fields tolerantly so older configs missing time/fuel still work.
      weights = {
        weight_safety:     Number(cfg.weight_safety ?? DEFAULT_WEIGHTS.weight_safety),
        weight_weather:    Number(cfg.weight_weather ?? DEFAULT_WEIGHTS.weight_weather),
        weight_traffic:    Number(cfg.weight_traffic ?? DEFAULT_WEIGHTS.weight_traffic),
        weight_efficiency: Number(cfg.weight_efficiency ?? DEFAULT_WEIGHTS.weight_efficiency),
        weight_time:       Number(cfg.weight_time ?? DEFAULT_WEIGHTS.weight_time),
        weight_fuel:       Number(cfg.weight_fuel ?? DEFAULT_WEIGHTS.weight_fuel),
      };
    }

    // ── 5. Historical bias from completed flights on this OD pair ───────
    const originKey = origin.toLowerCase().split("@")[0].trim();
    const destKey = destination.toLowerCase().split("@")[0].trim();
    const { data: pattern } = await supabase
      .from("route_patterns")
      .select("*")
      .eq("origin_key", originKey)
      .eq("destination_key", destKey)
      .maybeSingle();

    // ── 6. Score every candidate, then sort and pick the top 3 ──────────
    const scored = candidates.map((c, i) => {
      const score = scoreEval(evals[i], fastestTime, shortestDist, weights);
      let overall = score.overall;
      // Historical adjustment: if completed flights on this OD pair show a
      // consistent under- or over-performance vs the predicted average score,
      // shift this candidate's overall by a portion of that drift. This is
      // where the system "learns" from actual outcomes.
      if (pattern && (pattern.completed_flight_count ?? 0) >= 2) {
        const predicted = Number(pattern.avg_overall_score ?? 70);
        const adjusted = Number(pattern.outcome_adjusted_score ?? predicted);
        const drift = adjusted - predicted;
        overall = Math.max(10, Math.min(100, overall + drift * 0.3));
      }
      const distanceKm = Math.round(evals[i].distanceKm * 10) / 10;
      return {
        candidate: c,
        evaluation: evals[i],
        score: { ...score, overall: Math.round(overall) },
        distance_km: distanceKm,
        estimated_time_min: Math.round(evals[i].timeMin * 10) / 10,
      };
    });

    scored.sort((a, b) => b.score.overall - a.score.overall);
    const top3 = scored.slice(0, 3);

    // Build presentational route objects.
    const buildOperationalNote = (s: typeof top3[number]): string => {
      const e = s.evaluation;
      const bits: string[] = [];
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

    // For backwards compatibility the API still has `primary_route` / `alternate_routes`.
    const primaryRoute = { ...routes[0], is_selected: true };
    const alternateRoutes = routes.slice(1);

    // ── 7. Persist this evaluation for the learning loop ────────────────
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

    // ── 8. Upsert route_patterns so the next call has running averages ──
    if (pattern) {
      const n = pattern.flight_count + 1;
      const blend = (oldVal: number | null, fresh: number) =>
        ((Number(oldVal ?? fresh) * pattern.flight_count) + fresh) / n;
      await supabase
        .from("route_patterns")
        .update({
          flight_count: n,
          avg_overall_score: blend(pattern.avg_overall_score, primaryRoute.overall_score),
          avg_safety_score: blend(pattern.avg_safety_score, primaryRoute.safety_score),
          avg_weather_score: blend(pattern.avg_weather_score, primaryRoute.weather_score),
          avg_traffic_score: blend(pattern.avg_traffic_score, primaryRoute.traffic_score),
          avg_efficiency_score: blend(pattern.avg_efficiency_score, primaryRoute.efficiency_score),
          preferred_waypoints: primaryRoute.waypoints,
          last_updated: new Date().toISOString(),
        })
        .eq("id", pattern.id);
    } else {
      await supabase.from("route_patterns").insert({
        origin_key: originKey,
        destination_key: destKey,
        altitude_band,
        flight_count: 1,
        avg_overall_score: primaryRoute.overall_score,
        avg_safety_score: primaryRoute.safety_score,
        avg_weather_score: primaryRoute.weather_score,
        avg_traffic_score: primaryRoute.traffic_score,
        avg_efficiency_score: primaryRoute.efficiency_score,
        preferred_waypoints: primaryRoute.waypoints,
        last_updated: new Date().toISOString(),
      });
    }

    const historicalSuggestion = pattern && pattern.flight_count >= 2
      ? {
          found: true,
          flight_count: pattern.flight_count,
          completed_flight_count: pattern.completed_flight_count ?? 0,
          avg_score: Math.round(Number(pattern.avg_overall_score ?? 0)),
          outcome_adjusted_score: pattern.outcome_adjusted_score
            ? Math.round(Number(pattern.outcome_adjusted_score))
            : null,
          message:
            (pattern.completed_flight_count ?? 0) >= 2
              ? `Flown ${pattern.flight_count} times · ${pattern.completed_flight_count} completed. Outcome-adjusted: ${Math.round(Number(pattern.outcome_adjusted_score ?? pattern.avg_overall_score))}.`
              : `Flown ${pattern.flight_count} times. Avg planning score: ${Math.round(Number(pattern.avg_overall_score ?? 0))}.`,
        }
      : { found: false };

    return json({
      route_id: savedRoute?.id ?? crypto.randomUUID(),
      // Top-3 list (new clients should prefer this).
      top_routes: routes,
      // Back-compat for current clients.
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
        optimization_method: "Dynamic candidate generation with multi-axis scoring (time / wind / weather / turbulence / fuel / traffic / safety)",
        scoring_weights: weights,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Route optimizer error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
