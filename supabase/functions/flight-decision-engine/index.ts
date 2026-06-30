import { serve } from "std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SimulationResult {
  safe: boolean;
  predicted_conflicts: number;
  weather_at_arrival: string;
  energy_adequate: boolean;
  airspace_clear: boolean;
}

function simulateShortTerm(params: {
  trajectoryScore: number;
  weatherRisk: string;
  conflicts: number;
  weatherRiskScore: number;
  airspaceLoad: number;
  vertiportDelay: number;
  forecast15Risk: number;
}): SimulationResult {
  const { trajectoryScore, weatherRisk, conflicts, weatherRiskScore, airspaceLoad, forecast15Risk } = params;
  return {
    safe: trajectoryScore >= 70 && weatherRisk !== "high",
    predicted_conflicts: conflicts,
    weather_at_arrival: forecast15Risk >= 60 ? "high" : forecast15Risk >= 30 ? "moderate" : "low",
    energy_adequate: trajectoryScore >= 50, // proxy for route efficiency
    airspace_clear: airspaceLoad < 80,
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const {
      flight_intent_id,
      aircraft_id,
      operator_name,
      trajectory_score = 80,
      weather_risk = "low",
      conflicts = 0,
      route_data = null,
      weather_intel = null,
      airspace_schedule = null,
      vertiport_status = null,
      departure_window_start,
    } = await req.json();

    console.info("[flight-decision-engine] received request", {
      flight_intent_id,
      aircraft_id,
      trajectory_score,
      weather_risk,
      conflicts,
      has_route_data: !!route_data,
      has_weather_intel: !!weather_intel,
      has_airspace_schedule: !!airspace_schedule,
      has_vertiport_status: !!vertiport_status,
    });

    // Extract key signals
    const weatherRiskScore: number = weather_intel?.origin_weather?.risk_score ?? (weather_risk === "high" ? 70 : weather_risk === "moderate" ? 40 : 10);
    const forecast15Risk: number = weather_intel?.forecast?.t_plus_15?.risk_score ?? weatherRiskScore;
    const forecast30Risk: number = weather_intel?.forecast?.t_plus_30?.risk_score ?? weatherRiskScore;
    const weatherTrend: string = weather_intel?.forecast?.trend ?? "stable";
    const airspaceLoad: number = airspace_schedule?.load_percentage ?? 0;
    const airspaceCongested: boolean = airspace_schedule?.is_congested ?? false;
    const airspaceDelay: number = airspace_schedule?.delay_minutes ?? 0;
    const vertiportDelay: number = vertiport_status?.departure_delay_minutes ?? 0;
    const routeScore: number = route_data?.primary_route?.overall_score ?? trajectory_score;
    const primaryRouteId: string | null = route_data?.route_id ?? null;

    // Simulate next 15-minute window
    const sim = simulateShortTerm({
      trajectoryScore: trajectory_score,
      weatherRisk: weather_risk,
      conflicts,
      weatherRiskScore,
      airspaceLoad,
      vertiportDelay,
      forecast15Risk,
    });

    // ─────────────────────────────────────────────────────────────
    // DECISION MATRIX (single output: GO / DELAY / REROUTE)
    // ─────────────────────────────────────────────────────────────
    let decision: "GO" | "DELAY" | "REROUTE";
    let reason: string;
    let confidence: number;
    let delayMinutes = 0;
    let useRouteId: string | null = primaryRouteId;

    const depTime = new Date(departure_window_start ?? new Date().toISOString());
    let departureTime = new Date(depTime.getTime() + Math.max(airspaceDelay, vertiportDelay) * 60 * 1000);

    if (weatherRiskScore >= 60) {
      // High weather risk
      if (weatherTrend === "improving" && forecast30Risk < 40) {
        decision = "DELAY";
        delayMinutes = 30;
        departureTime = new Date(depTime.getTime() + 30 * 60 * 1000);
        reason = `High weather risk (${weatherRiskScore}/100). Conditions improve significantly in 30 minutes — delay recommended.`;
        confidence = 78;
      } else if (route_data?.alternate_routes?.length > 0) {
        decision = "REROUTE";
        const altRoute = route_data.alternate_routes[0];
        useRouteId = altRoute?.id ?? primaryRouteId;
        reason = `High weather risk on primary corridor (${weatherRiskScore}/100). Rerouting via ${altRoute?.label ?? "alternate corridor"} which avoids weather.`;
        confidence = 72;
      } else {
        decision = "DELAY";
        delayMinutes = 20;
        departureTime = new Date(depTime.getTime() + 20 * 60 * 1000);
        reason = `High weather risk (${weatherRiskScore}/100) with no safe alternate route. Delay 20 minutes.`;
        confidence = 70;
      }
    } else if (conflicts >= 3) {
      // High conflict density
      if (route_data?.alternate_routes?.length > 0) {
        decision = "REROUTE";
        const altRoute = route_data.alternate_routes.find((r: any) => r.traffic_score >= 70) ?? route_data.alternate_routes[0];
        useRouteId = altRoute?.id ?? primaryRouteId;
        reason = `${conflicts} active conflicts detected on primary route. Rerouting via ${altRoute?.label ?? "lower-traffic corridor"}.`;
        confidence = 80;
      } else {
        decision = "DELAY";
        delayMinutes = 15;
        departureTime = new Date(depTime.getTime() + 15 * 60 * 1000);
        reason = `${conflicts} airspace conflicts detected. Short delay of 15 minutes to allow traffic to clear.`;
        confidence = 75;
      }
    } else if (airspaceCongested) {
      decision = "DELAY";
      delayMinutes = airspaceDelay || 15;
      departureTime = new Date(depTime.getTime() + delayMinutes * 60 * 1000);
      reason = `Airspace segment at ${airspaceLoad}% capacity. Allocated slot in ${delayMinutes} minutes.`;
      confidence = 85;
    } else if (vertiportDelay > 0) {
      if (trajectory_score >= 75 && weatherRiskScore < 40 && conflicts === 0) {
        // Minor vertiport delay but otherwise clear — still GO with adjusted time
        decision = "GO";
        reason = `Vertiport departure slot available in ${vertiportDelay} min. All other conditions nominal.`;
        confidence = 82;
      } else {
        decision = "DELAY";
        delayMinutes = vertiportDelay;
        reason = `Vertiport capacity constraint requires ${vertiportDelay}-minute departure delay.`;
        confidence = 88;
      }
    } else if (trajectory_score < 55) {
      // Very poor trajectory score — check if reroute helps
      if (routeScore > trajectory_score + 15 && route_data?.primary_route) {
        decision = "REROUTE";
        reason = `Low trajectory score (${trajectory_score}/100). Optimized route improves score to ${routeScore}/100.`;
        confidence = 76;
      } else {
        decision = "DELAY";
        delayMinutes = 20;
        departureTime = new Date(depTime.getTime() + 20 * 60 * 1000);
        reason = `Low trajectory score (${trajectory_score}/100) — conditions insufficient for safe departure. Delay 20 minutes for reassessment.`;
        confidence = 68;
      }
    } else if (trajectory_score < 75 && (conflicts >= 1 || weatherRiskScore >= 30)) {
      // Moderate issues — reroute if better route available
      if (routeScore >= 80 && route_data?.primary_route) {
        decision = "REROUTE";
        reason = `Suboptimal trajectory (${trajectory_score}/100) with ${conflicts} conflict(s). Optimal route available scoring ${routeScore}/100.`;
        confidence = 79;
      } else {
        decision = "DELAY";
        delayMinutes = 10;
        departureTime = new Date(depTime.getTime() + 10 * 60 * 1000);
        reason = `Moderate trajectory issues (score: ${trajectory_score}/100). Brief 10-minute hold for conditions to stabilize.`;
        confidence = 74;
      }
    } else {
      // All clear — GO
      decision = "GO";
      reason = `All systems nominal. Trajectory score ${trajectory_score}/100, weather ${weather_risk}, ${conflicts} conflict(s). Cleared for departure.`;
      confidence = Math.min(98, 85 + Math.floor((trajectory_score - 75) / 5));
    }

    // Apply any scheduling delays on top
    const totalDelay = Math.max(delayMinutes, airspaceDelay, vertiportDelay);
    if (decision === "GO" && totalDelay > 0) {
      departureTime = new Date(depTime.getTime() + totalDelay * 60 * 1000);
    }
    if (decision === "DELAY") {
      delayMinutes = Math.max(delayMinutes, totalDelay);
      departureTime = new Date(depTime.getTime() + delayMinutes * 60 * 1000);
    }

    // Save decision to DB
    let savedDecisionId: string | null = null;
    if (flight_intent_id) {
      const { data: decisionRow } = await supabase
        .from("flight_decisions")
        .insert({
          flight_intent_id,
          aircraft_id: aircraft_id ?? "UNKNOWN",
          decision,
          reason,
          confidence,
          departure_time: departureTime.toISOString(),
          delay_minutes: delayMinutes,
          route_id: useRouteId,
          weather_risk,
          airspace_load: airspaceLoad,
          simulation_result: sim,
        })
        .select("id")
        .single();
      savedDecisionId = decisionRow?.id ?? null;
    }

    console.info("[flight-decision-engine] decision computed", {
      flight_intent_id,
      decision,
      confidence,
      delay_minutes: delayMinutes,
      route_id: useRouteId,
      saved_decision_id: savedDecisionId,
    });

    return new Response(JSON.stringify({
      decision_id: savedDecisionId,
      decision,
      reason,
      confidence,
      departure_time: departureTime.toISOString(),
      delay_minutes: delayMinutes,
      route_id: useRouteId,
      simulation: sim,
      inputs_summary: {
        trajectory_score,
        weather_risk,
        weather_risk_score: weatherRiskScore,
        conflicts,
        airspace_load: airspaceLoad,
        vertiport_delay: vertiportDelay,
        route_score: routeScore,
        forecast_trend: weatherTrend,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[flight-decision-engine] failed", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
