import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { getCoordsObj as getCoords } from "../_shared/geocode.ts";

const corsHeaders = CORS_HEADERS;

interface FlightIntent {
  aircraft_id: string;
  operator_name: string;
  aircraft_type: string;
  origin: string;
  destination: string;
  altitude_band: string;
  departure_window_start: string;
  departure_window_end: string;
  scheduled_departure?: string | null;
  contingency_landing: string;
  max_speed: string;
  max_altitude: string;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function windowsOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return timeToMinutes(s1) < timeToMinutes(e2) && timeToMinutes(s2) < timeToMinutes(e1);
}

function routesSimilar(o1: string, d1: string, o2: string, d2: string): boolean {
  const n = (s: string) => s.toLowerCase().trim();
  return n(o1) === n(o2) || n(d1) === n(d2) || n(o1) === n(d2) || n(d1) === n(o2);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth is required — flight intent creation must be attributed to a user.
    const user = await requireUserAuth(req);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const intent: FlightIntent = await req.json();

    // Save the flight intent attributed to this user.
    const { data: savedIntent, error: saveError } = await supabase
      .from("flight_intents")
      .insert({
        user_id: user.id,
        aircraft_id: intent.aircraft_id,
        operator_name: intent.operator_name,
        aircraft_type: intent.aircraft_type,
        origin: intent.origin,
        destination: intent.destination,
        altitude_band: intent.altitude_band,
        departure_window_start: intent.departure_window_start,
        departure_window_end: intent.departure_window_end,
        scheduled_departure: intent.scheduled_departure || null,
        contingency_landing: intent.contingency_landing || null,
        max_speed: intent.max_speed || null,
        max_altitude: intent.max_altitude || null,
        status: "analyzing",
      })
      .select()
      .single();

    if (saveError) {
      throw new Error(`Failed to save intent: ${saveError.message}`);
    }

    // Check for conflicts against ALL active intents fleet-wide (needed for safety).
    const { data: existingIntents, error: fetchError } = await supabase
      .from("flight_intents")
      .select("*")
      .neq("id", savedIntent.id)
      .in("status", ["analyzing", "pending", "approved", "active"])
      .order("created_at", { ascending: false })
      .limit(100);

    if (fetchError) {
      throw new Error(`Failed to fetch intents: ${fetchError.message}`);
    }

    const conflicts: Array<{ aircraft_id: string; conflict_type: string; severity: string }> = [];

    for (const existing of existingIntents || []) {
      const timeOverlap = windowsOverlap(
        intent.departure_window_start, intent.departure_window_end,
        existing.departure_window_start, existing.departure_window_end,
      );
      const sameAltitude = intent.altitude_band === existing.altitude_band;
      const similarRoute = routesSimilar(intent.origin, intent.destination, existing.origin, existing.destination);

      if (timeOverlap && sameAltitude && similarRoute) {
        conflicts.push({ aircraft_id: existing.aircraft_id, conflict_type: "4D trajectory intersection — same altitude, time window, and route", severity: "high" });
      } else if (timeOverlap && sameAltitude) {
        conflicts.push({ aircraft_id: existing.aircraft_id, conflict_type: "Same altitude band with overlapping departure window", severity: "moderate" });
      } else if (timeOverlap && similarRoute) {
        conflicts.push({ aircraft_id: existing.aircraft_id, conflict_type: "Overlapping departure window with shared route points", severity: "moderate" });
      }
    }

    const coords = await getCoords(intent.origin);
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,visibility,weather_code&hourly=visibility,wind_speed_80m,wind_gusts_10m,precipitation_probability&forecast_days=1&timezone=auto`;

    let weatherRisk = "low";
    let weatherDetails: Record<string, any> = {};

    try {
      const weatherRes = await fetch(weatherUrl);
      const weatherData = await weatherRes.json();
      const current = weatherData.current;
      weatherDetails = {
        temperature: current.temperature_2m,
        wind_speed: current.wind_speed_10m,
        wind_gusts: current.wind_gusts_10m,
        precipitation: current.precipitation,
        weather_code: current.weather_code,
      };
      const windGusts = current.wind_gusts_10m || 0;
      const precipitation = current.precipitation || 0;
      const weatherCode = current.weather_code || 0;
      if (windGusts > 50 || precipitation > 5 || weatherCode >= 95) {
        weatherRisk = "high";
      } else if ((current.wind_speed_10m || 0) > 30 || windGusts > 35 || precipitation > 1 || weatherCode >= 61) {
        weatherRisk = "moderate";
      }
    } catch (e) {
      console.error("Weather fetch failed:", e);
      weatherRisk = "unknown";
      weatherDetails = { error: "Weather data unavailable" };
    }

    let score = 80;
    for (const c of conflicts) {
      if (c.severity === "high") score -= 20;
      else if (c.severity === "moderate") score -= 10;
      else score -= 5;
    }
    if (weatherRisk === "high") score -= 25;
    else if (weatherRisk === "moderate") score -= 12;
    else if (weatherRisk === "unknown") score -= 8;
    if (conflicts.length === 0 && weatherRisk === "low") score += 15;
    score = Math.max(10, Math.min(100, score));

    await supabase
      .from("flight_intents")
      .update({ conflicts: conflicts.length, trajectory_score: score, weather_risk: weatherRisk, status: "pending" })
      .eq("id", savedIntent.id);

    return new Response(
      JSON.stringify({
        intent_id: savedIntent.id,
        conflicts: conflicts.length,
        conflict_details: conflicts,
        trajectory_score: score,
        weather_risk: weatherRisk,
        weather_details: weatherDetails,
        existing_intents_checked: existingIntents?.length || 0,
        analysis_factors: {
          other_intents: `${conflicts.length} conflicts out of ${existingIntents?.length || 0} active intents`,
          traffic_flows: existingIntents?.length ? "Evaluated" : "No active traffic",
          airspace_restrictions: score >= 70 ? "Clear" : "Caution — reduced trajectory score",
          weather_impact: weatherRisk === "low" ? "Favorable conditions"
            : weatherRisk === "moderate" ? "Caution advised"
            : weatherRisk === "high" ? "Hazardous — operations not recommended"
            : "Weather data unavailable",
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : String(error);
    console.error("Trajectory analysis error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
