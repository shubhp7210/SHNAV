import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";

function getPriority(aircraftType: string, isEmergency: boolean): number {
  if (isEmergency) return 100;
  if (aircraftType === "evtol") return 60;
  if (aircraftType === "rotorcraft") return 50;
  return 40;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const user = await requireUserAuth(req);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const {
      flight_intent_id,
      aircraft_id,
      aircraft_type = "evtol",
      altitude_band = "low",
      origin,
      destination,
      departure_window_start,
      departure_window_end,
      is_emergency = false,
    } = await req.json();

    // If a flight_intent_id is supplied, verify it belongs to this user.
    if (flight_intent_id) {
      const { data: ownedIntent } = await supabase
        .from("flight_intents")
        .select("id")
        .eq("id", flight_intent_id)
        .eq("user_id", user.id)
        .single();
      if (!ownedIntent) {
        return new Response(
          JSON.stringify({ error: "Flight intent not found or access denied" }),
          { status: 403, headers: corsHeaders },
        );
      }
    }

    const priority = getPriority(aircraft_type, is_emergency);
    const windowStart = new Date(departure_window_start);
    const windowEnd = new Date(departure_window_end);

    const { data: segments } = await supabase
      .from("airspace_segments")
      .select("*")
      .eq("altitude_band", altitude_band)
      .eq("is_no_fly", false)
      .limit(1);

    const segment = segments?.[0] ?? null;
    const segmentId = segment?.id ?? null;
    const capacityPerHour = segment?.capacity_per_hour ?? 8;

    // Count fleet-wide flights in this window — needed for true capacity check.
    const hourAgo = new Date(windowStart.getTime() - 60 * 60 * 1000).toISOString();
    const hourAhead = new Date(windowEnd.getTime() + 60 * 60 * 1000).toISOString();

    const { data: overlapping } = await supabase
      .from("flight_intents")
      .select("id, departure_window_start, departure_window_end, aircraft_type")
      .in("status", ["analyzing", "pending", "approved", "active"])
      .gte("departure_window_end", hourAgo)
      .lte("departure_window_start", hourAhead)
      .eq("altitude_band", altitude_band)
      .neq("id", flight_intent_id ?? "00000000-0000-0000-0000-000000000000");

    const competingFlights = overlapping ?? [];
    const slotWindowHours = (windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60);
    const capacityInWindow = Math.ceil(capacityPerHour * Math.max(slotWindowHours, 0.25));
    const currentLoad = competingFlights.length;
    const loadPct = Math.round((currentLoad / capacityPerHour) * 100);
    const capacityAvailable = currentLoad < capacityInWindow;

    let allocatedTime = departure_window_start;
    let delayMinutes = 0;
    let allocated = true;
    let reason = "";

    if (!capacityAvailable && !is_emergency) {
      delayMinutes = 15;
      allocated = false;
      const nextSlot = new Date(windowStart.getTime() + delayMinutes * 60 * 1000);
      allocatedTime = nextSlot.toISOString();
      reason = `Airspace segment at ${loadPct}% capacity. Next available slot in ${delayMinutes} minutes.`;

      const delayedEnd = new Date(nextSlot.getTime() + 15 * 60 * 1000).toISOString();
      const { data: delayedOverlap } = await supabase
        .from("flight_intents")
        .select("id")
        .in("status", ["analyzing", "pending", "approved", "active"])
        .gte("departure_window_end", nextSlot.toISOString())
        .lte("departure_window_start", delayedEnd)
        .eq("altitude_band", altitude_band);

      if ((delayedOverlap ?? []).length < capacityPerHour) {
        allocated = true;
        reason = `Allocated to next available slot (+${delayMinutes} min) due to capacity.`;
      } else {
        delayMinutes = 30;
        allocatedTime = new Date(windowStart.getTime() + 30 * 60 * 1000).toISOString();
        reason = `Airspace congested. Earliest slot in 30 minutes.`;
      }
    } else if (is_emergency) {
      allocated = true;
      reason = "Emergency priority — immediate slot allocated.";
    } else {
      allocated = true;
      reason = `Slot available. Current segment load: ${currentLoad}/${capacityPerHour} per hour (${loadPct}%).`;
    }

    if (segmentId && flight_intent_id) {
      const slotStart = new Date(allocatedTime);
      const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
      await supabase.from("time_slots").insert({
        segment_id: segmentId,
        flight_intent_id,
        aircraft_id,
        slot_start: slotStart.toISOString(),
        slot_end: slotEnd.toISOString(),
        priority,
        status: "allocated",
      });
    }

    return new Response(JSON.stringify({
      allocated,
      allocated_time: allocatedTime,
      delay_minutes: delayMinutes,
      priority,
      segment_name: segment?.name ?? "General Airspace",
      segment_load: currentLoad,
      segment_capacity: capacityPerHour,
      load_percentage: loadPct,
      is_congested: loadPct >= 80,
      reason,
      competing_flights: competingFlights.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    if (err instanceof Response) return err;
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
