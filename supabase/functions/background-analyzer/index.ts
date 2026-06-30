import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalSecret } from "../_shared/auth.ts";

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
    // System-only function — requires the internal secret, not a user JWT.
    // Set INTERNAL_FUNCTION_SECRET in Supabase project env vars / Vault.
    requireInternalSecret(req);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Query all active routes from the past 30 days (fleet-wide aggregate).
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: routes, error: routesError } = await supabase
      .from("routes")
      .select("*")
      .gte("created_at", since)
      .eq("status", "active");

    if (routesError) throw new Error(`Failed to fetch routes: ${routesError.message}`);

    const routeList = routes ?? [];
    let processedRoutes = routeList.length;
    let updatedPatterns = 0;

    interface RouteGroup {
      overall: number[];
      safety: number[];
      weather: number[];
      traffic: number[];
      efficiency: number[];
      waypoints: unknown;
    }
    const groups: Record<string, RouteGroup> = {};

    for (const route of routeList) {
      const key = `${(route.origin as string).toLowerCase().trim()}|${(route.destination as string).toLowerCase().trim()}|${route.altitude_band}`;
      if (!groups[key]) {
        groups[key] = { overall: [], safety: [], weather: [], traffic: [], efficiency: [], waypoints: null };
      }
      if (route.overall_score != null) groups[key].overall.push(Number(route.overall_score));
      if (route.safety_score != null) groups[key].safety.push(Number(route.safety_score));
      if (route.weather_score != null) groups[key].weather.push(Number(route.weather_score));
      if (route.traffic_score != null) groups[key].traffic.push(Number(route.traffic_score));
      if (route.efficiency_score != null) groups[key].efficiency.push(Number(route.efficiency_score));
      if (route.primary_route) {
        const pr = route.primary_route as { waypoints?: unknown };
        if (pr.waypoints) groups[key].waypoints = pr.waypoints;
      }
    }

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    // Upsert fleet-wide route_patterns (user_id IS NULL).
    for (const [key, group] of Object.entries(groups)) {
      const [originKey, destKey, altBand] = key.split("|");
      const count = group.overall.length;

      const { data: existing } = await supabase
        .from("route_patterns")
        .select("id, flight_count")
        .eq("origin_key", originKey)
        .eq("destination_key", destKey)
        .eq("altitude_band", altBand)
        .is("user_id", null)
        .single();

      const upsertData = {
        origin_key: originKey,
        destination_key: destKey,
        altitude_band: altBand,
        user_id: null,
        flight_count: count,
        avg_overall_score: avg(group.overall),
        avg_safety_score: avg(group.safety),
        avg_weather_score: avg(group.weather),
        avg_traffic_score: avg(group.traffic),
        avg_efficiency_score: avg(group.efficiency),
        preferred_waypoints: group.waypoints,
        last_updated: new Date().toISOString(),
      };

      if (existing) {
        await supabase.from("route_patterns").update(upsertData).eq("id", existing.id);
      } else {
        await supabase.from("route_patterns").insert(upsertData);
      }
      updatedPatterns++;
    }

    // Adaptive weight adjustment based on fleet-wide safety scores.
    const allSafetyScores = routeList.map((r) => Number(r.safety_score ?? 0));
    const globalAvgSafety = allSafetyScores.length > 0 ? avg(allSafetyScores) : 100;

    const { data: config } = await supabase
      .from("route_score_config")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    let weightAdjustments: Record<string, number | string> = {};

    if (config && globalAvgSafety < 70) {
      const newSafety = Math.min(0.50, Number(config.weight_safety) + 0.02);
      const newEfficiency = Math.max(0.05, Number(config.weight_efficiency) - 0.02);
      await supabase
        .from("route_score_config")
        .update({ weight_safety: newSafety, weight_efficiency: newEfficiency, updated_at: new Date().toISOString() })
        .eq("id", config.id);
      weightAdjustments = {
        weight_safety: newSafety,
        weight_efficiency: newEfficiency,
        reason: `avg_safety_score ${Math.round(globalAvgSafety)} < 70 — increased safety weight`,
      };
    }

    return new Response(
      JSON.stringify({
        processed_routes: processedRoutes,
        updated_patterns: updatedPatterns,
        global_avg_safety: Math.round(globalAvgSafety),
        weight_adjustments: weightAdjustments,
        timestamp: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : String(error);
    console.error("Background analyzer error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
