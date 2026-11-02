// Live traffic for conflict checks: every flight whose departure window lies
// near the candidate's, with the coordinates stored at filing time (no
// per-request geocoding — that was an N+1 against Nominatim).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EVTOL_BASE_SPEED_KMH } from "./constants.ts";
import { epochMinutes } from "./departure.ts";
import type { FlightTrack } from "./conflicts.ts";

export const LIVE_STATUSES = ["analyzing", "pending", "approved", "active", "in_air"];

export interface TrafficRow {
  id: string;
  user_id: string | null;
  aircraft_id: string;
  altitude_band: string | null;
  status: string;
  departure_start_at: string | null;
  departure_end_at: string | null;
  origin_lat: number | null; origin_lon: number | null;
  dest_lat: number | null; dest_lon: number | null;
}

export const TRAFFIC_COLUMNS =
  "id, user_id, aircraft_id, altitude_band, status, departure_start_at, departure_end_at, origin_lat, origin_lon, dest_lat, dest_lon";

/** Flights whose departure windows fall within ±`marginH` hours of [start, end]. */
export async function loadTraffic(
  admin: SupabaseClient,
  opts: { start: Date; end: Date; excludeId?: string | null; marginH?: number; limit?: number },
): Promise<TrafficRow[]> {
  const m = (opts.marginH ?? 3) * 3_600_000;
  let q = admin.from("flight_intents").select(TRAFFIC_COLUMNS)
    .in("status", LIVE_STATUSES)
    .lte("departure_start_at", new Date(opts.end.getTime() + m).toISOString())
    .gte("departure_end_at", new Date(opts.start.getTime() - m).toISOString())
    .order("departure_start_at", { ascending: true })
    .limit(opts.limit ?? 500);
  if (opts.excludeId) q = q.neq("id", opts.excludeId);
  const { data, error } = await q;
  if (error) throw new Error(`traffic query failed: ${error.message}`);
  return (data ?? []) as TrafficRow[];
}

/** Straight-leg track from a stored row; empty path when coordinates are missing
 *  (checkNetwork then reports it as skipped instead of guessing a position). */
export function trackFromRow(r: TrafficRow, aircraftLabel?: string): FlightTrack {
  const ok = r.origin_lat != null && r.origin_lon != null && r.dest_lat != null && r.dest_lon != null;
  return {
    id: r.id,
    aircraftId: aircraftLabel ?? r.aircraft_id,
    path: ok ? [{ lat: r.origin_lat!, lon: r.origin_lon! }, { lat: r.dest_lat!, lon: r.dest_lon! }] : [],
    depStartMin: r.departure_start_at ? epochMinutes(r.departure_start_at) : NaN,
    depEndMin: r.departure_end_at ? epochMinutes(r.departure_end_at) : NaN,
    altitudeBand: r.altitude_band ?? "low",
    cruiseKmh: EVTOL_BASE_SPEED_KMH,
  };
}
