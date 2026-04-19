import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface FlightIntent {
  aircraft_id: string;
  operator_name: string;
  aircraft_type: string;
  origin: string;
  destination: string;
  altitude_band: string;
  departure_window_start: string;
  departure_window_end: string;
  contingency_landing: string;
  max_speed: string;
  max_altitude: string;
}

// Simple coordinate lookup for common locations (expandable)
const LOCATION_COORDS: Record<string, { lat: number; lon: number }> = {
  default: { lat: 40.7128, lon: -74.006 }, // NYC default
};

function getCoords(location: string): { lat: number; lon: number } {
  const key = location.toLowerCase().trim();
  return LOCATION_COORDS[key] || LOCATION_COORDS["default"];
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function windowsOverlap(
  s1: string,
  e1: string,
  s2: string,
  e2: string
): boolean {
  const start1 = timeToMinutes(s1);
  const end1 = timeToMinutes(e1);
  const start2 = timeToMinutes(s2);
  const end2 = timeToMinutes(e2);
  return start1 < end2 && start2 < end1;
}

function routesSimilar(o1: string, d1: string, o2: string, d2: string): boolean {
  // Check if routes share origin or destination (potential conflict points)
  const normalize = (s: string) => s.toLowerCase().trim();
  return (
    normalize(o1) === normalize(o2) ||
    normalize(d1) === normalize(d2) ||
    normalize(o1) === normalize(d2) ||
    normalize(d1) === normalize(o2)
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Resolve the calling user from the forwarded JWT so we can attribute
    // the flight intent to them (required for RLS read access).
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      try {
        const userClient = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: u } = await userClient.auth.getUser(token);
        userId = u?.user?.id ?? null;
      } catch (_e) {
        userId = null;
      }
    }

    const intent: FlightIntent = await req.json();

    // 1. Save the flight intent to the database
    const { data: savedIntent, error: saveError } = await supabase
      .from("flight_intents")
      .insert({
        user_id: userId,
        aircraft_id: intent.aircraft_id,
        operator_name: intent.operator_name,
        aircraft_type: intent.aircraft_type,
        origin: intent.origin,
        destination: intent.destination,
        altitude_band: intent.altitude_band,
        departure_window_start: intent.departure_window_start,
        departure_window_end: intent.departure_window_end,
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

    // 2. Check for conflicts against OTHER active flight intents
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

    // Conflict analysis
    const conflicts: Array<{
      aircraft_id: string;
      conflict_type: string;
      severity: string;
    }> = [];

    for (const existing of existingIntents || []) {
      const timeOverlap = windowsOverlap(
        intent.departure_window_start,
        intent.departure_window_end,
        existing.departure_window_start,
        existing.departure_window_end
      );

      const sameAltitude = intent.altitude_band === existing.altitude_band;
      const similarRoute = routesSimilar(
        intent.origin,
        intent.destination,
        existing.origin,
        existing.destination
      );

      if (timeOverlap && sameAltitude && similarRoute) {
        conflicts.push({
          aircraft_id: existing.aircraft_id,
          conflict_type: "4D trajectory intersection — same altitude, time window, and route",
          severity: "high",
        });
      } else if (timeOverlap && sameAltitude) {
        conflicts.push({
          aircraft_id: existing.aircraft_id,
          conflict_type: "Same altitude band with overlapping departure window",
          severity: "moderate",
        });
      } else if (timeOverlap && similarRoute) {
        conflicts.push({
          aircraft_id: existing.aircraft_id,
          conflict_type: "Overlapping departure window with shared route points",
          severity: "moderate",
        });
      }
    }

    // 3. Fetch real-time weather from Open-Meteo (free, no API key)
    const coords = getCoords(intent.origin);
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,visibility,weather_code&hourly=visibility,wind_speed_80m,wind_gusts_10m,precipitation_probability&forecast_days=1&timezone=auto`;

    let weatherData: any = null;
    let weatherRisk = "low";
    let weatherDetails: Record<string, any> = {};

    try {
      const weatherRes = await fetch(weatherUrl);
      weatherData = await weatherRes.json();

      const current = weatherData.current;
      weatherDetails = {
        temperature: current.temperature_2m,
        wind_speed: current.wind_speed_10m,
        wind_gusts: current.wind_gusts_10m,
        precipitation: current.precipitation,
        weather_code: current.weather_code,
      };

      // Determine weather risk based on actual conditions
      const windSpeed = current.wind_speed_10m || 0;
      const windGusts = current.wind_gusts_10m || 0;
      const precipitation = current.precipitation || 0;
      const weatherCode = current.weather_code || 0;

      // Weather risk assessment for low-altitude eVTOL ops
      if (
        windGusts > 50 ||
        precipitation > 5 ||
        weatherCode >= 95 // thunderstorm
      ) {
        weatherRisk = "high";
      } else if (
        windSpeed > 30 ||
        windGusts > 35 ||
        precipitation > 1 ||
        weatherCode >= 61 // rain
      ) {
        weatherRisk = "moderate";
      } else {
        weatherRisk = "low";
      }
    } catch (e) {
      console.error("Weather fetch failed:", e);
      weatherRisk = "unknown";
      weatherDetails = { error: "Weather data unavailable" };
    }

    // 4. Calculate trajectory score
    let score = 95; // start high
    score -= conflicts.length * 10; // each conflict reduces score
    if (weatherRisk === "high") score -= 20;
    else if (weatherRisk === "moderate") score -= 10;
    if (weatherRisk === "unknown") score -= 5;
    score = Math.max(10, Math.min(100, score));

    // 5. Update the saved intent with analysis results
    await supabase
      .from("flight_intents")
      .update({
        conflicts: conflicts.length,
        trajectory_score: score,
        weather_risk: weatherRisk,
        status: "pending",
      })
      .eq("id", savedIntent.id);

    // 6. Return results
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
          airspace_restrictions:
            score >= 70 ? "Clear" : "Caution — reduced trajectory score",
          weather_impact:
            weatherRisk === "low"
              ? "Favorable conditions"
              : weatherRisk === "moderate"
              ? "Caution advised — check wind/precipitation"
              : weatherRisk === "high"
              ? "Hazardous — operations not recommended"
              : "Weather data unavailable",
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Trajectory analysis error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
