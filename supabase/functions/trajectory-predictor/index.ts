import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVTOL_SPEED_KMH = 90;
const MIN_SEPARATION_KM = 0.5;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Interpolate position along great-circle path given progress 0..1
function interpolatePosition(
  oLat: number, oLon: number,
  dLat: number, dLon: number,
  progress: number
): { lat: number; lon: number } {
  return {
    lat: oLat + (dLat - oLat) * progress,
    lon: oLon + (dLon - oLon) * progress,
  };
}

// Approximate coords from text locations (same lookup as other functions)
const CITY_COORDS: Record<string, [number, number]> = {
  "new york": [40.7128, -74.006], "nyc": [40.7128, -74.006],
  "los angeles": [34.0522, -118.2437],
  "chicago": [41.8781, -87.6298], "miami": [25.7617, -80.1918],
  "san francisco": [37.7749, -122.4194],
  "houston": [29.7604, -95.3698], "boston": [42.3601, -71.0589],
  "seattle": [47.6062, -122.3321], "dallas": [32.7767, -96.797],
  "downtown": [40.7128, -74.006], "uptown": [40.7831, -73.9712],
  "airport": [40.758, -73.9855], "bay": [40.6892, -74.0445],
  "east": [40.7282, -73.9442],
};

function parseTaggedCoords(loc: string): [number, number] | null {
  const tagged = loc.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (tagged) {
    const lat = parseFloat(tagged[1]);
    const lon = parseFloat(tagged[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }

  const bare = loc.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lon = parseFloat(bare[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }

  return null;
}

async function getCoords(loc: string): Promise<[number, number]> {
  if (!loc?.trim()) return [40.7128, -74.006];

  const parsed = parseTaggedCoords(loc);
  if (parsed) return parsed;

  const lower = loc.toLowerCase();
  for (const [k, v] of Object.entries(CITY_COORDS)) {
    if (lower.includes(k)) return v;
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(loc)}`,
      { headers: { "User-Agent": "Altos-ATM/1.0", "Accept-Language": "en" } }
    );
    const arr = await res.json();
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
      return [parseFloat(arr[0].lat), parseFloat(arr[0].lon)];
    }
  } catch (error) {
    console.error("Trajectory predictor geocode failed:", error);
  }

  return [40.7128, -74.006];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { flight_intent_id } = await req.json();
    console.info("[trajectory-predictor] received request", { flight_intent_id });

    // Fetch all active/pending flights
    const { data: activeFlights } = await supabase
      .from("flight_intents")
      .select("id, aircraft_id, origin, destination, altitude_band, departure_window_start, departure_window_end, status")
      .in("status", ["active", "approved", "pending"])
      .limit(50);

    const flights = activeFlights ?? [];
    const now = Date.now();

    // Build position predictions for each flight
    const predictions = await Promise.all(flights.map(async (f: any) => {
      const [oLat, oLon] = await getCoords(f.origin ?? "");
      const [dLat, dLon] = await getCoords(f.destination ?? "");
      const depStart = new Date(f.departure_window_start).getTime();
      const totalDistKm = haversineKm(oLat, oLon, dLat, dLon);
      const totalDurationMs = (totalDistKm / EVTOL_SPEED_KMH) * 3600 * 1000;
      const elapsed = Math.max(0, now - depStart);
      const progress = Math.min(1, elapsed / totalDurationMs);

      const positions: Array<{ t_plus_min: number; lat: number; lon: number; altitude_band: string }> = [];
      for (const min of [0, 1, 2, 3, 4, 5]) {
        const futureElapsed = elapsed + min * 60 * 1000;
        const futureProgress = Math.min(1, futureElapsed / totalDurationMs);
        const pos = interpolatePosition(oLat, oLon, dLat, dLon, futureProgress);
        positions.push({ t_plus_min: min, ...pos, altitude_band: f.altitude_band });
      }

      return {
        flight_intent_id: f.id,
        aircraft_id: f.aircraft_id,
        altitude_band: f.altitude_band,
        current_progress: Math.round(progress * 100),
        predicted_positions: positions,
        origin: f.origin,
        destination: f.destination,
        status: f.status,
      };
    }));

    // Detect future conflicts between all pairs
    const conflicts: Array<{
      aircraft_a: string;
      aircraft_b: string;
      t_plus_min: number;
      separation_km: number;
      severity: string;
      resolution: { type: string; action: string };
    }> = [];

    for (let i = 0; i < predictions.length; i++) {
      for (let j = i + 1; j < predictions.length; j++) {
        const a = predictions[i];
        const b = predictions[j];
        // Only conflict if same altitude band
        if (a.altitude_band !== b.altitude_band) continue;

        for (const posA of a.predicted_positions) {
          const posB = b.predicted_positions.find(p => p.t_plus_min === posA.t_plus_min);
          if (!posB) continue;
          const sep = haversineKm(posA.lat, posA.lon, posB.lat, posB.lon);
          if (sep < MIN_SEPARATION_KM * 3) { // 1.5km warning zone
            const severity = sep < MIN_SEPARATION_KM ? "high" : sep < MIN_SEPARATION_KM * 2 ? "moderate" : "low";
            // Choose resolution strategy
            let resolution: { type: string; action: string };
            if (severity === "high") {
              resolution = { type: "altitude_adjustment", action: `Move ${b.aircraft_id} to ${b.altitude_band === "low" ? "mid" : "low"} altitude band immediately` };
            } else if (severity === "moderate") {
              resolution = { type: "speed_adjustment", action: `Reduce speed of ${b.aircraft_id} by 20% for 2 minutes` };
            } else {
              resolution = { type: "route_deviation", action: `Apply 0.3km lateral offset to ${b.aircraft_id} route` };
            }
            conflicts.push({
              aircraft_a: a.aircraft_id,
              aircraft_b: b.aircraft_id,
              t_plus_min: posA.t_plus_min,
              separation_km: Math.round(sep * 100) / 100,
              severity,
              resolution,
            });
            break; // One conflict per pair
          }
        }
      }
    }

    // Calculate system-wide flow efficiency
    const activeCount = predictions.filter(p => p.current_progress > 0 && p.current_progress < 100).length;
    const conflictPenalty = conflicts.length * 5;
    const flowEfficiency = Math.max(0, 100 - conflictPenalty);

    // For the requesting flight, compute specific prediction
    const myFlight = predictions.find(p => p.flight_intent_id === flight_intent_id);
    const myConflicts = conflicts.filter(c => c.aircraft_a === myFlight?.aircraft_id || c.aircraft_b === myFlight?.aircraft_id);

    console.info("[trajectory-predictor] prediction summary", {
      flight_intent_id,
      total_predictions: predictions.length,
      total_conflicts: conflicts.length,
      matched_flight: myFlight?.aircraft_id ?? null,
    });

    return new Response(JSON.stringify({
      predictions: flight_intent_id ? [myFlight ?? null] : predictions,
      future_conflicts: flight_intent_id ? myConflicts : conflicts,
      total_active_flights: activeCount,
      system_flow_efficiency: flowEfficiency,
      total_conflicts_detected: conflicts.length,
      high_severity_conflicts: conflicts.filter(c => c.severity === "high").length,
      analysis_horizon_minutes: 5,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
