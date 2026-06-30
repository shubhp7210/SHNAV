import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { origin, destination, altitude_band } = body;

    const originKey = (origin as string).toLowerCase().trim();
    const destKey = (destination as string).toLowerCase().trim();
    const band = (altitude_band as string).toLowerCase().trim();

    const { data: pattern, error } = await supabase
      .from("route_patterns")
      .select("*")
      .eq("origin_key", originKey)
      .eq("destination_key", destKey)
      .eq("altitude_band", band)
      .single();

    if (error && error.code !== "PGRST116") {
      throw new Error(error.message);
    }

    if (pattern && pattern.flight_count >= 2) {
      return new Response(
        JSON.stringify({
          found: true,
          pattern: {
            id: pattern.id,
            origin_key: pattern.origin_key,
            destination_key: pattern.destination_key,
            altitude_band: pattern.altitude_band,
            flight_count: pattern.flight_count,
            avg_overall_score: Math.round(pattern.avg_overall_score),
            avg_safety_score: Math.round(pattern.avg_safety_score),
            avg_weather_score: Math.round(pattern.avg_weather_score),
            avg_traffic_score: Math.round(pattern.avg_traffic_score),
            avg_efficiency_score: Math.round(pattern.avg_efficiency_score),
            preferred_waypoints: pattern.preferred_waypoints ?? [],
            last_updated: pattern.last_updated,
          },
          message: `This OD pair has been flown ${pattern.flight_count} times. Historical avg score: ${Math.round(pattern.avg_overall_score)}.`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ found: false }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Pattern learner error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
