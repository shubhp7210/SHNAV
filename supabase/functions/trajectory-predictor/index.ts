// Short-horizon (5 min) conflict prediction for the caller's live flights,
// polled by the monitoring screen.
//
//  • Fleet-wide: the caller's flights are checked against ALL live traffic
//    (previously only against their own fleet). Other operators appear as
//    anonymous "TFC-xxxx" labels — no registrations or routes are exposed.
//  • In-air flights are included (status "in_air" was missing from the filter,
//    so a flight dropped out of prediction the moment it took off).
//  • Positions come from stored coordinates + absolute departure time — no
//    per-poll geocoding (that was an N+1 against Nominatim every 5 seconds).
import { serve } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody, validateFields } from "../_shared/validate.ts";
import { EVTOL_BASE_SPEED_KMH, MIN_SEPARATION_KM } from "../_shared/constants.ts";
import { haversineKm, interpolatePosition } from "../_shared/geo.ts";
import { loadTraffic, type TrafficRow } from "../_shared/traffic.ts";
import { trafficLabel } from "../_shared/anonymize.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HORIZON_MIN = 5;

interface Prediction {
  flight_intent_id: string | null;
  aircraft_id: string;
  own: boolean;
  altitude_band: string;
  current_progress: number;
  predicted_positions: { t_plus_min: number; lat: number; lon: number; altitude_band: string }[];
  status: string;
}

function predict(r: TrafficRow, own: boolean, now: number): Prediction | null {
  if (r.origin_lat == null || r.dest_lat == null || !r.departure_start_at) return null;
  const dist = haversineKm(r.origin_lat, r.origin_lon!, r.dest_lat, r.dest_lon!);
  const durMs = Math.max(1, (dist / EVTOL_BASE_SPEED_KMH) * 3_600_000);
  const elapsed = now - new Date(r.departure_start_at).getTime();
  // Not departing within the horizon: it's on the pad, not traffic.
  if (elapsed + HORIZON_MIN * 60_000 < 0) return null;
  const positions = [];
  for (let m = 0; m <= HORIZON_MIN; m++) {
    const p = Math.min(1, Math.max(0, (elapsed + m * 60_000) / durMs));
    positions.push({ t_plus_min: m, ...interpolatePosition(r.origin_lat, r.origin_lon!, r.dest_lat, r.dest_lon!, p), altitude_band: r.altitude_band ?? "low" });
  }
  return {
    flight_intent_id: own ? r.id : null,
    aircraft_id: own ? r.aircraft_id : trafficLabel(r.id),
    own,
    altitude_band: r.altitude_band ?? "low",
    current_progress: Math.round(Math.min(1, Math.max(0, elapsed / durMs)) * 100),
    predicted_positions: positions,
    status: r.status,
  };
}

serve("trajectory-predictor", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);
  const rl = await checkRateLimit(admin, user.id, "trajectory-predictor", 120, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const { flight_intent_id } = validateFields(await readBody(req), {
    flight_intent_id: { type: "string", maxLength: 36, pattern: UUID },
  }) as { flight_intent_id?: string };

  const now = Date.now();
  // Flights departing or airborne around now (±2 h covers any eVTOL leg here).
  const traffic = await loadTraffic(admin, { start: new Date(now), end: new Date(now), marginH: 2 });
  const preds = traffic
    .map((r) => predict(r, r.user_id === user.id, now))
    .filter((p): p is Prediction => p !== null && p.current_progress < 100);
  const mine = preds.filter((p) => p.own && (!flight_intent_id || p.flight_intent_id === flight_intent_id));

  const conflicts: {
    aircraft_a: string; aircraft_b: string; t_plus_min: number; separation_km: number;
    severity: "high" | "moderate" | "low"; resolution: { type: string; action: string };
  }[] = [];
  for (const a of mine) {
    for (const b of preds) {
      if (a === b || a.altitude_band !== b.altitude_band) continue;
      if (b.own && mine.includes(b) && mine.indexOf(b) < mine.indexOf(a)) continue; // own pairs once
      for (const pa of a.predicted_positions) {
        const pb = b.predicted_positions[pa.t_plus_min];
        const sep = haversineKm(pa.lat, pa.lon, pb.lat, pb.lon);
        if (sep >= MIN_SEPARATION_KM * 3) continue;
        const severity = sep < MIN_SEPARATION_KM ? "high" : sep < MIN_SEPARATION_KM * 2 ? "moderate" : "low";
        const other = a.altitude_band === "low" ? "mid" : "low";
        conflicts.push({
          aircraft_a: a.aircraft_id, aircraft_b: b.aircraft_id, t_plus_min: pa.t_plus_min,
          separation_km: Math.round(sep * 100) / 100, severity,
          resolution: severity === "high"
            ? { type: "altitude_adjustment", action: `Move ${a.aircraft_id} to the ${other} band now` }
            : severity === "moderate"
              ? { type: "speed_adjustment", action: `Reduce ${a.aircraft_id} speed by 20% for 2 minutes` }
              : { type: "route_deviation", action: `Apply a 0.3 km lateral offset to ${a.aircraft_id}` },
        });
        break;
      }
    }
  }

  const airborne = preds.filter((p) => p.current_progress > 0).length;
  return json({
    predictions: mine,
    future_conflicts: conflicts,
    total_active_flights: airborne,
    system_flow_efficiency: Math.max(0, 100 - conflicts.length * 5),
    total_conflicts_detected: conflicts.length,
    high_severity_conflicts: conflicts.filter((c) => c.severity === "high").length,
    analysis_horizon_minutes: HORIZON_MIN,
    traffic_considered: preds.length,
  });
});
