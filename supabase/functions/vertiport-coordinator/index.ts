import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, EVTOL_BASE_SPEED_KMH } from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { haversineKm } from "../_shared/geo.ts";

const corsHeaders = CORS_HEADERS;

function matchVertiport(location: string, vertiports: any[]): any | null {
  const lower = location.toLowerCase();
  for (const vp of vertiports) {
    if (lower.includes(vp.name.toLowerCase()) || vp.name.toLowerCase().includes(lower.split(",")[0].trim())) {
      return vp;
    }
    if (vp.city && lower.includes(vp.city.toLowerCase())) return vp;
  }
  if (lower.includes("downtown") || lower.includes("center") || lower.includes("central")) {
    return vertiports.find((v: any) => v.name.includes("Downtown")) ?? vertiports[0];
  }
  if (lower.includes("airport") || lower.includes("north")) {
    return vertiports.find((v: any) => v.name.includes("Airport")) ?? vertiports[1];
  }
  if (lower.includes("east")) return vertiports.find((v: any) => v.name.includes("East")) ?? vertiports[0];
  if (lower.includes("west") || lower.includes("bay") || lower.includes("waterfront")) {
    return vertiports.find((v: any) => v.name.includes("Bay")) ?? vertiports[0];
  }
  return vertiports[0] ?? null;
}

Deno.serve(async (req) => {
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
      origin,
      destination,
      departure_time,
    } = await req.json();

    // Verify flight ownership before assigning vertiport slots.
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

    const depTime = new Date(departure_time ?? new Date().toISOString());
    const windowStart = new Date(depTime.getTime() - 30 * 60 * 1000).toISOString();
    const windowEnd = new Date(depTime.getTime() + 30 * 60 * 1000).toISOString();

    const { data: vertiports } = await supabase.from("vertiports").select("*").eq("is_active", true);
    const allVPs = vertiports ?? [];

    const originVP = matchVertiport(origin ?? "", allVPs);
    const destVP = matchVertiport(destination ?? "", allVPs);

    const { data: originDeps } = await supabase
      .from("vertiport_slots")
      .select("id")
      .eq("slot_type", "departure")
      .eq("vertiport_id", originVP?.id ?? "")
      .in("status", ["scheduled", "active"])
      .gte("scheduled_time", windowStart)
      .lte("scheduled_time", windowEnd);

    const distKm = originVP && destVP
      ? haversineKm(originVP.lat, originVP.lon, destVP.lat, destVP.lon)
      : 20;
    const flightMinutes = Math.ceil((distKm / EVTOL_BASE_SPEED_KMH) * 60) + 5;
    const estimatedArrival = new Date(depTime.getTime() + flightMinutes * 60 * 1000);
    const arrWindowStart = new Date(estimatedArrival.getTime() - 20 * 60 * 1000).toISOString();
    const arrWindowEnd = new Date(estimatedArrival.getTime() + 20 * 60 * 1000).toISOString();

    const { data: destArrivals } = await supabase
      .from("vertiport_slots")
      .select("id")
      .eq("slot_type", "arrival")
      .eq("vertiport_id", destVP?.id ?? "")
      .in("status", ["scheduled", "active"])
      .gte("scheduled_time", arrWindowStart)
      .lte("scheduled_time", arrWindowEnd);

    const depCount = (originDeps ?? []).length;
    const arrCount = (destArrivals ?? []).length;
    const maxDep = originVP?.max_departures_per_hour ?? 4;
    const maxArr = destVP?.max_arrivals_per_hour ?? 4;
    const depCapacityOk = depCount < maxDep;
    const arrCapacityOk = arrCount < maxArr;

    let departureDelay = 0;
    let adjustedDepartureTime = departure_time;
    let reason = "";

    if (!depCapacityOk && !arrCapacityOk) {
      departureDelay = 20;
      adjustedDepartureTime = new Date(depTime.getTime() + 20 * 60 * 1000).toISOString();
      reason = `Both origin and destination vertiports at capacity. Delay by ${departureDelay} min.`;
    } else if (!depCapacityOk) {
      departureDelay = 15;
      adjustedDepartureTime = new Date(depTime.getTime() + 15 * 60 * 1000).toISOString();
      reason = `Origin vertiport (${originVP?.name}) at departure capacity. Delay by ${departureDelay} min.`;
    } else if (!arrCapacityOk) {
      departureDelay = 10;
      adjustedDepartureTime = new Date(depTime.getTime() + 10 * 60 * 1000).toISOString();
      reason = `Destination vertiport (${destVP?.name}) arrival slot constrained. Delay by ${departureDelay} min.`;
    } else {
      reason = "Both vertiports have available capacity.";
    }

    if (flight_intent_id && originVP && destVP) {
      await supabase.from("vertiport_slots").insert([
        {
          vertiport_id: originVP.id,
          flight_intent_id,
          aircraft_id,
          slot_type: "departure",
          scheduled_time: adjustedDepartureTime,
          status: "scheduled",
          delay_minutes: departureDelay,
        },
        {
          vertiport_id: destVP.id,
          flight_intent_id,
          aircraft_id,
          slot_type: "arrival",
          scheduled_time: new Date(new Date(adjustedDepartureTime).getTime() + flightMinutes * 60 * 1000).toISOString(),
          status: "scheduled",
        },
      ]);
    }

    return new Response(JSON.stringify({
      origin_vertiport: {
        id: originVP?.id,
        name: originVP?.name ?? "Unknown",
        departures_in_window: depCount,
        max_departures_per_hour: maxDep,
        load_pct: Math.round((depCount / maxDep) * 100),
        capacity_ok: depCapacityOk,
      },
      destination_vertiport: {
        id: destVP?.id,
        name: destVP?.name ?? "Unknown",
        arrivals_in_window: arrCount,
        max_arrivals_per_hour: maxArr,
        load_pct: Math.round((arrCount / maxArr) * 100),
        capacity_ok: arrCapacityOk,
      },
      departure_capacity_ok: depCapacityOk,
      arrival_capacity_ok: arrCapacityOk,
      departure_delay_minutes: departureDelay,
      adjusted_departure_time: adjustedDepartureTime,
      estimated_arrival_time: new Date(new Date(adjustedDepartureTime).getTime() + flightMinutes * 60 * 1000).toISOString(),
      flight_time_minutes: flightMinutes,
      distance_km: Math.round(distKm),
      reason,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    if (err instanceof Response) return err;
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
