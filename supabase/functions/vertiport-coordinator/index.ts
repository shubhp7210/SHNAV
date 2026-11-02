// Vertiport departure/arrival slot coordination for a filed flight.
//
// Vertiports are matched by real distance (≤3 km from the stored coordinates);
// an endpoint with no registered vertiport nearby is reported as "not checked"
// instead of being matched to an arbitrary pad. Capacity check + reservation are
// atomic inside public.reserve_vertiport_slots(); re-running replaces the flight's
// reservations instead of stacking duplicates.
import { serve, httpError } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody, validateFields } from "../_shared/validate.ts";
import { nearestVertiport, type VertiportRow } from "../_shared/vertiport.ts";
import { haversineKm } from "../_shared/geo.ts";
import { EVTOL_BASE_SPEED_KMH } from "../_shared/constants.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fixed allowance for taxi, climb-out and approach. */
const GROUND_AND_APPROACH_MIN = 5;

serve("vertiport-coordinator", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);
  const rl = await checkRateLimit(admin, user.id, "vertiport-coordinator", 30, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const body = validateFields(await readBody(req), {
    flight_intent_id: { required: true, type: "string", maxLength: 36, pattern: UUID },
  }) as { flight_intent_id: string };

  const { data: fi } = await admin.from("flight_intents")
    .select("id, aircraft_id, departure_start_at, origin_lat, origin_lon, dest_lat, dest_lon, status")
    .eq("id", body.flight_intent_id).eq("user_id", user.id).maybeSingle();
  if (!fi) throw httpError(403, "Flight intent not found or access denied");
  if (!fi.departure_start_at) throw httpError(422, "Flight intent has no departure time — refile the flight");
  if (["expired", "archived", "landed"].includes(fi.status)) throw httpError(409, `Flight is ${fi.status}`);

  const { data: vps, error: vpErr } = await admin.from("vertiports")
    .select("id, name, lat, lon, max_departures_per_hour, max_arrivals_per_hour, faa_id").eq("is_active", true);
  if (vpErr) throw new Error(`vertiports query failed: ${vpErr.message}`);
  const all = (vps ?? []) as VertiportRow[];
  const oPt = fi.origin_lat != null ? { lat: fi.origin_lat, lon: fi.origin_lon } : null;
  const dPt = fi.dest_lat != null ? { lat: fi.dest_lat, lon: fi.dest_lon } : null;
  const om = nearestVertiport(oPt, all);
  const dm = nearestVertiport(dPt, all);

  const distKm = oPt && dPt ? haversineKm(oPt.lat, oPt.lon, dPt.lat, dPt.lon) : null;
  const flightMin = distKm != null ? Math.ceil((distKm / EVTOL_BASE_SPEED_KMH) * 60) + GROUND_AND_APPROACH_MIN : GROUND_AND_APPROACH_MIN;

  const { data: r, error } = await admin.rpc("reserve_vertiport_slots", {
    p_intent: fi.id, p_aircraft: fi.aircraft_id,
    p_origin_vp: om?.vertiport.id ?? null, p_dest_vp: dm?.vertiport.id ?? null,
    p_departure: fi.departure_start_at, p_flight_minutes: flightMin,
  });
  if (error) throw new Error(`reserve_vertiport_slots failed: ${error.message}`);

  const checked = !!(om || dm);
  const assessment = {
    checked, reserved: !!r.reserved, delay_minutes: r.delay_minutes ?? null,
    origin_vertiport_id: om?.vertiport.id ?? null, destination_vertiport_id: dm?.vertiport.id ?? null,
    computed_at: r.computed_at,
  };
  await admin.from("flight_intents").update({ vertiport_assessment: assessment }).eq("id", fi.id);

  const side = (m: typeof om, s: Record<string, unknown> | null, kind: "dep" | "arr") => m && s ? {
    id: m.vertiport.id, name: m.vertiport.name, faa_id: m.vertiport.faa_id ?? null,
    distance_km: Math.round(m.distanceKm * 10) / 10,
    [kind === "dep" ? "departures_in_window" : "arrivals_in_window"]: s.load,
    [kind === "dep" ? "max_departures_per_hour" : "max_arrivals_per_hour"]: s.capacity_per_hour,
    load_pct: s.load_pct, capacity_ok: s.capacity_ok, checked: true,
  } : { name: "No registered vertiport within 3 km", load_pct: 0, capacity_ok: true, checked: false };

  const delay = r.delay_minutes ?? 0;
  const reason = !checked
    ? "Neither endpoint is within 3 km of a registered vertiport — pad capacity was not checked."
    : !r.reserved
      ? "No departure/arrival slot pair available within 60 minutes."
      : delay > 0 ? `Pad capacity requires a ${delay}-minute departure delay; slots reserved.`
      : "Departure and arrival slots reserved at the requested time.";

  return json({
    origin_vertiport: side(om, r.origin, "dep"),
    destination_vertiport: side(dm, r.destination, "arr"),
    departure_capacity_ok: r.origin ? !!r.origin.capacity_ok : true,
    arrival_capacity_ok: r.destination ? !!r.destination.capacity_ok : true,
    reserved: !!r.reserved,
    departure_delay_minutes: delay,
    adjusted_departure_time: r.adjusted_departure_time ?? fi.departure_start_at,
    estimated_arrival_time: r.estimated_arrival_time ??
      new Date(new Date(fi.departure_start_at).getTime() + flightMin * 60_000).toISOString(),
    flight_time_minutes: flightMin,
    distance_km: distKm != null ? Math.round(distKm * 10) / 10 : null,
    capacity_source: "configured planning values",
    reason,
  });
});
