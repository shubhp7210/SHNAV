import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ──────────────────────────────────────────────
// Location lookup table
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// Haversine distance (km)
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// Weather penalty (0.0 – 2.0)
// ──────────────────────────────────────────────
function computeWeatherPenalty(wind: number, gusts: number, precip: number, code: number): number {
  let p = 0;
  if (gusts > 50 || precip > 5 || code >= 95) p = 2.0;
  else if (wind > 30 || gusts > 35 || precip > 1 || code >= 61) p = 1.2;
  else if (wind > 20 || gusts > 25 || precip > 0.2) p = 0.6;
  else p = 0.1;
  return p;
}

// ──────────────────────────────────────────────
// Grid node type
// ──────────────────────────────────────────────
interface GridNode {
  lat: number;
  lon: number;
  cost: number; // weather_penalty + traffic_penalty
  g: number;
  h: number;
  f: number;
  parent: string | null;
}

function nodeKey(row: number, col: number): string {
  return `${row},${col}`;
}

// ──────────────────────────────────────────────
// A* on a 10x8 grid
// ──────────────────────────────────────────────
function aStarRoute(
  originCoords: [number, number],
  destCoords: [number, number],
  gridCosts: number[][]
): [number, number][] {
  const ROWS = 8;
  const COLS = 10;

  const [oLat, oLon] = originCoords;
  const [dLat, dLon] = destCoords;

  // Bounding box with 30% margin
  const latMargin = Math.abs(dLat - oLat) * 0.30 + 0.05;
  const lonMargin = Math.abs(dLon - oLon) * 0.30 + 0.05;

  const minLat = Math.min(oLat, dLat) - latMargin;
  const maxLat = Math.max(oLat, dLat) + latMargin;
  const minLon = Math.min(oLon, dLon) - lonMargin;
  const maxLon = Math.max(oLon, dLon) + lonMargin;

  const latStep = (maxLat - minLat) / (ROWS - 1);
  const lonStep = (maxLon - minLon) / (COLS - 1);

  // Build grid
  const grid: GridNode[][] = [];
  for (let r = 0; r < ROWS; r++) {
    grid[r] = [];
    for (let c = 0; c < COLS; c++) {
      const lat = minLat + r * latStep;
      const lon = minLon + c * lonStep;
      const cost = (gridCosts[r]?.[c]) ?? 0;
      grid[r][c] = { lat, lon, cost, g: Infinity, h: 0, f: Infinity, parent: null };
    }
  }

  // Find start/end nodes (nearest grid node to origin/destination)
  let startR = 0, startC = 0, endR = ROWS - 1, endC = COLS - 1;
  let minDistStart = Infinity, minDistEnd = Infinity;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ds = haversine(oLat, oLon, grid[r][c].lat, grid[r][c].lon);
      const de = haversine(dLat, dLon, grid[r][c].lat, grid[r][c].lon);
      if (ds < minDistStart) { minDistStart = ds; startR = r; startC = c; }
      if (de < minDistEnd) { minDistEnd = de; endR = r; endC = c; }
    }
  }

  grid[startR][startC].g = 0;
  grid[startR][startC].h = haversine(grid[startR][startC].lat, grid[startR][startC].lon, dLat, dLon);
  grid[startR][startC].f = grid[startR][startC].h;

  const open = new Set<string>([nodeKey(startR, startC)]);
  const closed = new Set<string>();
  let iterations = 0;

  while (open.size > 0 && iterations < 300) {
    iterations++;

    // Find node with lowest f in open
    let curKey = "";
    let curF = Infinity;
    for (const k of open) {
      const [r, c] = k.split(",").map(Number);
      if (grid[r][c].f < curF) { curF = grid[r][c].f; curKey = k; }
    }

    const [curR, curC] = curKey.split(",").map(Number);
    if (curR === endR && curC === endC) break;

    open.delete(curKey);
    closed.add(curKey);

    // 8-connected neighbors
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = curR + dr;
        const nc = curC + dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const nk = nodeKey(nr, nc);
        if (closed.has(nk)) continue;

        const moveDist = haversine(grid[curR][curC].lat, grid[curR][curC].lon, grid[nr][nc].lat, grid[nr][nc].lon);
        const tentativeG = grid[curR][curC].g + moveDist * (1 + grid[nr][nc].cost);

        if (tentativeG < grid[nr][nc].g) {
          grid[nr][nc].g = tentativeG;
          grid[nr][nc].h = haversine(grid[nr][nc].lat, grid[nr][nc].lon, dLat, dLon);
          grid[nr][nc].f = grid[nr][nc].g + grid[nr][nc].h;
          grid[nr][nc].parent = curKey;
          open.add(nk);
        }
      }
    }
  }

  // Reconstruct path
  const path: [number, number][] = [];
  let cur: string | null = nodeKey(endR, endC);
  while (cur) {
    const [r, c] = cur.split(",").map(Number);
    path.unshift([grid[r][c].lat, grid[r][c].lon]);
    cur = grid[r][c].parent;
  }

  // Prepend actual origin and append actual dest
  if (path.length === 0) return [[oLat, oLon], [dLat, dLon]];
  path.unshift([oLat, oLon]);
  path.push([dLat, dLon]);

  return smoothPath(path);
}

// Remove collinear points (tolerance ~0.01 degrees)
function smoothPath(path: [number, number][]): [number, number][] {
  if (path.length <= 2) return path;
  const result: [number, number][] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const [lat0, lon0] = path[i - 1];
    const [lat1, lon1] = path[i];
    const [lat2, lon2] = path[i + 1];
    // Cross product magnitude to check collinearity
    const cross = Math.abs((lat1 - lat0) * (lon2 - lon0) - (lon1 - lon0) * (lat2 - lat0));
    if (cross > 1e-4) result.push([lat1, lon1]);
  }
  result.push(path[path.length - 1]);
  return result;
}

// ──────────────────────────────────────────────
// Sinusoidal arc (north or south)
// ──────────────────────────────────────────────
function arcRoute(
  originCoords: [number, number],
  destCoords: [number, number],
  direction: "north" | "south",
  points = 20
): [number, number][] {
  const [oLat, oLon] = originCoords;
  const [dLat, dLon] = destCoords;
  const dist = haversine(oLat, oLon, dLat, dLon);
  const deviation = dist * 0.15; // 15% of distance
  const sign = direction === "north" ? 1 : -1;

  const waypoints: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    const lat = oLat + t * (dLat - oLat) + sign * deviation * Math.sin(Math.PI * t) * (1 / 111.32);
    const lon = oLon + t * (dLon - oLon);
    waypoints.push([lat, lon]);
  }
  return waypoints;
}

// ──────────────────────────────────────────────
// Route distance
// ──────────────────────────────────────────────
function routeDistance(waypoints: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < waypoints.length; i++) {
    d += haversine(waypoints[i - 1][0], waypoints[i - 1][1], waypoints[i][0], waypoints[i][1]);
  }
  return d;
}

// ──────────────────────────────────────────────
// Time windows overlap check
// ──────────────────────────────────────────────
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function windowsOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return timeToMinutes(s1) < timeToMinutes(e2) && timeToMinutes(s2) < timeToMinutes(e1);
}

// ──────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
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

    const originCoords = await getCoords(origin);
    const destCoords = await getCoords(destination);
    const midLat = (originCoords[0] + destCoords[0]) / 2;
    const midLon = (originCoords[1] + destCoords[1]) / 2;

    // ── 1. Fetch weather at origin, midpoint, destination ──
    const fetchWeather = async (lat: number, lon: number) => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,visibility,weather_code&forecast_days=1&timezone=auto`;
      const res = await fetch(url);
      return res.json();
    };

    const [originWx, midWx, destWx] = await Promise.allSettled([
      fetchWeather(originCoords[0], originCoords[1]),
      fetchWeather(midLat, midLon),
      fetchWeather(destCoords[0], destCoords[1]),
    ]);

    interface WeatherPoint {
      wind_speed: number;
      wind_gusts: number;
      precipitation: number;
      temperature: number;
      weather_code: number;
      visibility: number;
    }

    const extractWx = (result: PromiseSettledResult<any>): WeatherPoint => {
      if (result.status === "fulfilled") {
        const c = result.value?.current ?? {};
        return {
          wind_speed: c.wind_speed_10m ?? 0,
          wind_gusts: c.wind_gusts_10m ?? 0,
          precipitation: c.precipitation ?? 0,
          temperature: c.temperature_2m ?? 0,
          weather_code: c.weather_code ?? 0,
          visibility: c.visibility ?? 10000,
        };
      }
      return { wind_speed: 0, wind_gusts: 0, precipitation: 0, temperature: 20, weather_code: 0, visibility: 10000 };
    };

    const wx0 = extractWx(originWx);
    const wx1 = extractWx(midWx);
    const wx2 = extractWx(destWx);

    const penalties = [
      computeWeatherPenalty(wx0.wind_speed, wx0.wind_gusts, wx0.precipitation, wx0.weather_code),
      computeWeatherPenalty(wx1.wind_speed, wx1.wind_gusts, wx1.precipitation, wx1.weather_code),
      computeWeatherPenalty(wx2.wind_speed, wx2.wind_gusts, wx2.precipitation, wx2.weather_code),
    ];

    // Interpolate weather penalty across 10x8 grid
    const ROWS = 8, COLS = 10;
    const gridCosts: number[][] = [];
    for (let r = 0; r < ROWS; r++) {
      gridCosts[r] = [];
      for (let c = 0; c < COLS; c++) {
        const t = c / (COLS - 1); // 0 = origin, 1 = destination
        let wp: number;
        if (t < 0.5) {
          wp = penalties[0] + (penalties[1] - penalties[0]) * (t * 2);
        } else {
          wp = penalties[1] + (penalties[2] - penalties[1]) * ((t - 0.5) * 2);
        }
        gridCosts[r][c] = wp;
      }
    }

    // ── 2. Traffic conflict detection ──
    const { data: existingIntents } = await supabase
      .from("flight_intents")
      .select("*")
      .in("status", ["analyzing", "pending", "approved", "active"])
      .neq("id", flight_intent_id ?? "00000000-0000-0000-0000-000000000000")
      .order("created_at", { ascending: false })
      .limit(100);

    interface ConflictEntry {
      aircraft_id: string;
      conflict_type: string;
      severity: "high" | "moderate" | "low";
    }
    const conflicts: ConflictEntry[] = [];
    let trafficPenalty = 0;

    for (const intent of existingIntents ?? []) {
      if (!windowsOverlap(departure_window_start, departure_window_end, intent.departure_window_start, intent.departure_window_end)) continue;

      const sameAlt = intent.altitude_band === altitude_band;
      const iOrigin = await getCoords(intent.origin);
      const iDest = await getCoords(intent.destination);
      const nearOrigin = haversine(originCoords[0], originCoords[1], iOrigin[0], iOrigin[1]) < 20;
      const nearDest = haversine(destCoords[0], destCoords[1], iDest[0], iDest[1]) < 20;
      const routeSimilar = nearOrigin || nearDest;

      if (sameAlt && routeSimilar) {
        conflicts.push({
          aircraft_id: intent.aircraft_id,
          conflict_type: "4D trajectory intersection — same altitude, overlapping window, shared route points",
          severity: "high",
        });
        trafficPenalty += 0.8;
      } else if (sameAlt) {
        conflicts.push({
          aircraft_id: intent.aircraft_id,
          conflict_type: "Same altitude band with overlapping departure window",
          severity: "moderate",
        });
        trafficPenalty += 0.4;
      } else if (routeSimilar) {
        conflicts.push({
          aircraft_id: intent.aircraft_id,
          conflict_type: "Overlapping departure window with shared route points",
          severity: "low",
        });
        trafficPenalty += 0.2;
      }
    }

    // Add traffic penalty to grid nodes near origin/destination
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (c < 2 || c > COLS - 3) gridCosts[r][c] += trafficPenalty;
      }
    }

    // ── 3. Generate 3 candidate routes ──
    const primaryWaypoints = aStarRoute(originCoords, destCoords, gridCosts);
    const northWaypoints = arcRoute(originCoords, destCoords, "north", 20);
    const southWaypoints = arcRoute(originCoords, destCoords, "south", 20);

    const straightDist = haversine(originCoords[0], originCoords[1], destCoords[0], destCoords[1]);

    const avgPenalty = (penalties[0] + penalties[1] + penalties[2]) / 3;

    // ── 4. Scoring function ──
    const scoreRoute = (
      waypoints: [number, number][],
      conflictsOnRoute: number,
      wxPenaltyAvg: number,
      trafficDensity: number,
      distKm: number
    ) => {
      const safety = Math.max(10, 100 - conflictsOnRoute * 15);
      const weather = Math.max(10, 100 - wxPenaltyAvg * 40);
      const traffic = Math.max(10, 100 - trafficDensity * 20);
      const efficiency = Math.max(10, 100 - (distKm / Math.max(straightDist, 0.1) - 1) * 60);
      const overall = safety * 0.35 + weather * 0.25 + traffic * 0.25 + efficiency * 0.15;
      return { safety: Math.round(safety), weather: Math.round(weather), traffic: Math.round(traffic), efficiency: Math.round(efficiency), overall: Math.round(overall) };
    };

    const primaryDist = routeDistance(primaryWaypoints);
    const northDist = routeDistance(northWaypoints);
    const southDist = routeDistance(southWaypoints);

    const primaryScores = scoreRoute(primaryWaypoints, conflicts.length, avgPenalty, Math.min(trafficPenalty, 5), primaryDist);
    const northScores = scoreRoute(northWaypoints, Math.max(0, conflicts.length - 1), avgPenalty * 0.9, Math.max(0, trafficPenalty - 0.3), northDist);
    const southScores = scoreRoute(southWaypoints, Math.max(0, conflicts.length - 1), avgPenalty * 0.85, Math.max(0, trafficPenalty - 0.2), southDist);

    const eVTOL_SPEED_KMH = 90;

    // ── 5. Selection reason ──
    let selectionReason = "Optimal A* path — lowest combined risk score.";
    if (conflicts.length > 0) {
      selectionReason += ` ${conflicts.length} traffic conflict(s) detected; A* routing minimizes exposure.`;
    }
    if (avgPenalty > 1.0) {
      selectionReason += " Weather conditions elevated — route selected avoids highest-penalty nodes.";
    } else {
      selectionReason += " Weather conditions favorable along selected corridor.";
    }

    const weatherRisk: "low" | "moderate" | "high" | "unknown" =
      avgPenalty >= 1.5 ? "high" : avgPenalty >= 0.8 ? "moderate" : "low";

    // ── 6. Historical pattern lookup ──
    const originKey = origin.toLowerCase().trim();
    const destKey = destination.toLowerCase().trim();

    const { data: pattern } = await supabase
      .from("route_patterns")
      .select("*")
      .eq("origin_key", originKey)
      .eq("destination_key", destKey)
      .eq("altitude_band", altitude_band)
      .single();

    const historicalSuggestion = pattern && pattern.flight_count >= 2
      ? {
          found: true,
          flight_count: pattern.flight_count,
          avg_score: Math.round(pattern.avg_overall_score),
          suggested_waypoints: (pattern.preferred_waypoints as [number, number][]) ?? [],
          message: `This OD pair has been flown ${pattern.flight_count} times. Historical avg score: ${Math.round(pattern.avg_overall_score)}.`,
        }
      : { found: false };

    // ── 7. Build response objects ──
    const primaryRoute = {
      id: "primary",
      label: "Optimized Route",
      waypoints: primaryWaypoints.map(([lat, lon]) => ({ lat, lon })),
      distance_km: Math.round(primaryDist * 10) / 10,
      estimated_time_min: Math.round((primaryDist / eVTOL_SPEED_KMH) * 60 * 10) / 10,
      overall_score: primaryScores.overall,
      safety_score: primaryScores.safety,
      weather_score: primaryScores.weather,
      traffic_score: primaryScores.traffic,
      efficiency_score: primaryScores.efficiency,
      is_selected: true,
      selection_reason: selectionReason,
    };

    const alternateRoutes = [
      {
        id: "northern-arc",
        label: "Northern Arc",
        waypoints: northWaypoints.map(([lat, lon]) => ({ lat, lon })),
        distance_km: Math.round(northDist * 10) / 10,
        estimated_time_min: Math.round((northDist / eVTOL_SPEED_KMH) * 60 * 10) / 10,
        overall_score: northScores.overall,
        safety_score: northScores.safety,
        weather_score: northScores.weather,
        traffic_score: northScores.traffic,
        efficiency_score: northScores.efficiency,
        is_selected: false,
        selection_reason: "Northern sinusoidal arc — avoids primary corridor congestion.",
      },
      {
        id: "southern-arc",
        label: "Southern Arc",
        waypoints: southWaypoints.map(([lat, lon]) => ({ lat, lon })),
        distance_km: Math.round(southDist * 10) / 10,
        estimated_time_min: Math.round((southDist / eVTOL_SPEED_KMH) * 60 * 10) / 10,
        overall_score: southScores.overall,
        safety_score: southScores.safety,
        weather_score: southScores.weather,
        traffic_score: southScores.traffic,
        efficiency_score: southScores.efficiency,
        is_selected: false,
        selection_reason: "Southern sinusoidal arc — alternative deviation with different weather exposure.",
      },
    ];

    const weatherConditions = {
      wind_speed: wx0.wind_speed,
      wind_gusts: wx0.wind_gusts,
      precipitation: wx0.precipitation,
      temperature: wx0.temperature,
      weather_code: wx0.weather_code,
      visibility: wx0.visibility,
    };

    // ── 8. Save to DB ──
    const { data: savedRoute, error: saveError } = await supabase
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
        overall_score: primaryScores.overall,
        safety_score: primaryScores.safety,
        weather_score: primaryScores.weather,
        traffic_score: primaryScores.traffic,
        efficiency_score: primaryScores.efficiency,
        conflict_details: conflicts,
        weather_conditions: weatherConditions,
        weather_risk: weatherRisk,
        selection_reason: selectionReason,
        status: "active",
      })
      .select("id")
      .single();

    if (saveError) {
      console.error("Failed to save route:", saveError.message);
    }

    // Upsert route_patterns
    if (pattern) {
      const n = pattern.flight_count + 1;
      await supabase
        .from("route_patterns")
        .update({
          flight_count: n,
          avg_overall_score: (pattern.avg_overall_score * pattern.flight_count + primaryScores.overall) / n,
          avg_safety_score: (pattern.avg_safety_score * pattern.flight_count + primaryScores.safety) / n,
          avg_weather_score: (pattern.avg_weather_score * pattern.flight_count + primaryScores.weather) / n,
          avg_traffic_score: (pattern.avg_traffic_score * pattern.flight_count + primaryScores.traffic) / n,
          avg_efficiency_score: (pattern.avg_efficiency_score * pattern.flight_count + primaryScores.efficiency) / n,
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
        avg_overall_score: primaryScores.overall,
        avg_safety_score: primaryScores.safety,
        avg_weather_score: primaryScores.weather,
        avg_traffic_score: primaryScores.traffic,
        avg_efficiency_score: primaryScores.efficiency,
        preferred_waypoints: primaryRoute.waypoints,
        last_updated: new Date().toISOString(),
      });
    }

    // ── 9. Return response ──
    return new Response(
      JSON.stringify({
        route_id: savedRoute?.id ?? crypto.randomUUID(),
        primary_route: primaryRoute,
        alternate_routes: alternateRoutes,
        conflict_details: conflicts,
        weather_conditions: weatherConditions,
        weather_risk: weatherRisk,
        historical_suggestion: historicalSuggestion,
        analysis_summary: {
          total_conflicts: conflicts.length,
          routes_evaluated: 3,
          optimization_method: "A* on 10x8 airspace grid with weather+traffic cost nodes",
          scoring_weights: { safety: 0.35, weather: 0.25, traffic: 0.25, efficiency: 0.15 },
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Route optimizer error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
