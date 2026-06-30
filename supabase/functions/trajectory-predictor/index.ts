import { serve } from "std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CORS_HEADERS,
  EVTOL_BASE_SPEED_KMH as EVTOL_SPEED_KMH,
  MIN_SEPARATION_KM,
} from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { getCoords } from "../_shared/geocode.ts";
import { haversineKm, interpolatePosition } from "../_shared/geo.ts";

const corsHeaders = CORS_HEADERS;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const user = await requireUserAuth(req);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { flight_intent_id } = await req.json();
    console.info("[trajectory-predictor] received request", { flight_intent_id, user_id: user.id });

    // Fetch only this user's active flights — never expose other operators' data.
    const { data: activeFlights } = await supabase
      .from("flight_intents")
      .select("id, aircraft_id, origin, destination, altitude_band, departure_window_start, departure_window_end, status")
      .in("status", ["active", "approved", "pending"])
      .eq("user_id", user.id)
      .limit(50);

    const flights = activeFlights ?? [];
    const now = Date.now();

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

    // Detect conflicts within the user's own fleet.
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
        if (a.altitude_band !== b.altitude_band) continue;

        for (const posA of a.predicted_positions) {
          const posB = b.predicted_positions.find(p => p.t_plus_min === posA.t_plus_min);
          if (!posB) continue;
          const sep = haversineKm(posA.lat, posA.lon, posB.lat, posB.lon);
          if (sep < MIN_SEPARATION_KM * 3) {
            const severity = sep < MIN_SEPARATION_KM ? "high" : sep < MIN_SEPARATION_KM * 2 ? "moderate" : "low";
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
            break;
          }
        }
      }
    }

    const activeCount = predictions.filter(p => p.current_progress > 0 && p.current_progress < 100).length;
    const conflictPenalty = conflicts.length * 5;
    const flowEfficiency = Math.max(0, 100 - conflictPenalty);

    const myFlight = predictions.find(p => p.flight_intent_id === flight_intent_id);
    const myConflicts = conflicts.filter(c => c.aircraft_a === myFlight?.aircraft_id || c.aircraft_b === myFlight?.aircraft_id);

    console.info("[trajectory-predictor] prediction summary", {
      user_id: user.id,
      flight_intent_id,
      total_predictions: predictions.length,
      total_conflicts: conflicts.length,
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
    if (err instanceof Response) return err;
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
