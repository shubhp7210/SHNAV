// Airspace slot allocation for a filed flight.
//
// Capacity check and reservation happen atomically inside
// public.reserve_airspace_slot() under an advisory lock, so two simultaneous
// requests can no longer both take the last slot. Time comes from the intent's
// stored absolute departure window (the old code compared minutes-of-day across
// all dates and mixed a ±60-min count with an hourly capacity).
import { serve, httpError } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody, validateFields } from "../_shared/validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function priorityFor(aircraftType: string, emergency: boolean): number {
  if (emergency) return 100;
  if (aircraftType === "evtol") return 60;
  if (aircraftType === "rotorcraft") return 50;
  return 40;
}

serve("airspace-scheduler", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);
  const rl = await checkRateLimit(admin, user.id, "airspace-scheduler", 30, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const body = validateFields(await readBody(req), {
    flight_intent_id: { required: true, type: "string", maxLength: 36, pattern: UUID },
    is_emergency:     { type: "boolean" },
  }) as { flight_intent_id: string; is_emergency?: boolean };

  const { data: fi } = await admin.from("flight_intents")
    .select("id, aircraft_id, aircraft_type, altitude_band, departure_start_at, status")
    .eq("id", body.flight_intent_id).eq("user_id", user.id).maybeSingle();
  if (!fi) throw httpError(403, "Flight intent not found or access denied");
  if (!fi.departure_start_at) throw httpError(422, "Flight intent has no departure time — refile the flight");
  if (["expired", "archived", "landed"].includes(fi.status)) throw httpError(409, `Flight is ${fi.status}`);

  // Emergency priority is not self-service: it requires an operator workflow
  // that doesn't exist yet, so the flag is accepted only for logging.
  const emergency = false;
  const { data: r, error } = await admin.rpc("reserve_airspace_slot", {
    p_intent: fi.id, p_aircraft: fi.aircraft_id, p_band: fi.altitude_band ?? "low",
    p_start: fi.departure_start_at, p_priority: priorityFor(fi.aircraft_type, emergency), p_emergency: emergency,
  });
  if (error) throw new Error(`reserve_airspace_slot failed: ${error.message}`);

  const loadPct = Number(r.load_percentage ?? 0);
  const assessment = {
    allocated: !!r.allocated,
    allocated_time: r.allocated_time ?? null,
    delay_minutes: r.delay_minutes ?? null,
    load_percentage: loadPct,
    capacity_per_hour: r.capacity_per_hour,
    computed_at: r.computed_at,
  };
  await admin.from("flight_intents").update({ airspace_assessment: assessment }).eq("id", fi.id);

  const reason = !r.allocated
    ? r.reason ?? `No slot in the ${fi.altitude_band} band within 60 minutes (${r.load}/${r.capacity_per_hour} per hour reserved).`
    : r.delay_minutes > 0
      ? `Band at capacity at the requested time (${r.load}/${r.capacity_per_hour} per hour). Slot reserved +${r.delay_minutes} min.`
      : `Slot reserved. ${r.load}/${r.capacity_per_hour} flights per hour already reserved in this band (${loadPct}%).`;

  return json({
    allocated: !!r.allocated,
    allocated_time: r.allocated_time ?? fi.departure_start_at,
    delay_minutes: r.delay_minutes ?? 0,
    priority: priorityFor(fi.aircraft_type, emergency),
    segment_name: r.segment_name ?? "No open segment",
    segment_load: r.load ?? 0,
    segment_capacity: r.capacity_per_hour ?? 0,
    load_percentage: loadPct,
    is_congested: loadPct >= 80,
    reason,
    competing_flights: r.load ?? 0,
    capacity_model: "band-level hourly capacity (segments carry no corridor geometry)",
    emergency_requested: !!body.is_emergency,
  });
});
