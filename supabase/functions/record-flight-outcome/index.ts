// Captures an actual flight outcome, classifies it against the prediction,
// updates the OD-pair's running outcome-adjusted score, and — when there's
// a systematic prediction error across the fleet — nudges the scoring
// weights in route_score_config. This is the self-correction step.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Issue {
  type: string;
  severity: "low" | "moderate" | "high";
  description: string;
}

interface RequestBody {
  flight_intent_id: string;
  aircraft_id: string;
  route_id?: string | null;
  decision_id?: string | null;
  planned_departure_time?: string | null;
  actual_departure_time?: string | null;
  planned_arrival_time?: string | null;
  actual_arrival_time?: string | null;
  planned_duration_minutes?: number | null;
  actual_duration_minutes?: number;
  delay_minutes?: number;
  predicted_overall_score?: number | null;
  predicted_weather_risk?: string | null;
  experienced_max_wind_kmh?: number;
  experienced_max_gusts_kmh?: number;
  experienced_turbulence_probability?: number;
  experienced_route_deviation_m?: number;
  reroute_count?: number;
  issues_encountered?: Issue[];
  completion_status?: "completed" | "aborted" | "diverted";
}

function classifyAccuracy(deltaMin: number): "accurate" | "optimistic" | "pessimistic" {
  if (deltaMin > 5) return "optimistic";   // engine under-predicted time
  if (deltaMin < -5) return "pessimistic"; // engine over-predicted time
  return "accurate";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const {
      flight_intent_id,
      aircraft_id,
      route_id = null,
      decision_id = null,
      planned_departure_time = null,
      actual_departure_time = null,
      planned_arrival_time = null,
      actual_arrival_time = new Date().toISOString(),
      planned_duration_minutes = null,
      actual_duration_minutes = 0,
      delay_minutes = 0,
      predicted_overall_score = null,
      predicted_weather_risk = null,
      experienced_max_wind_kmh = 0,
      experienced_max_gusts_kmh = 0,
      experienced_turbulence_probability = 0,
      experienced_route_deviation_m = 0,
      reroute_count = 0,
      issues_encountered = [],
      completion_status = "completed",
    } = body;

    if (!flight_intent_id || !aircraft_id) {
      return json({ error: "flight_intent_id and aircraft_id are required" }, 400);
    }

    const durationDelta = planned_duration_minutes != null
      ? Number(actual_duration_minutes) - Number(planned_duration_minutes)
      : 0;
    const decisionAccuracy = classifyAccuracy(durationDelta);

    // ── 1. Upsert outcome (idempotent on flight_intent_id) ──────────────
    const { data: outcomeRow, error: outcomeErr } = await supabase
      .from("flight_outcomes")
      .upsert({
        flight_intent_id,
        aircraft_id,
        route_id,
        decision_id,
        planned_departure_time,
        actual_departure_time,
        planned_arrival_time,
        actual_arrival_time,
        planned_duration_minutes,
        actual_duration_minutes,
        delay_minutes,
        predicted_overall_score,
        predicted_weather_risk,
        experienced_max_wind_kmh,
        experienced_max_gusts_kmh,
        experienced_turbulence_probability,
        experienced_route_deviation_m,
        reroute_count,
        decision_accuracy: decisionAccuracy,
        issues_encountered,
        completion_status,
        completed_at: new Date().toISOString(),
      }, { onConflict: "flight_intent_id" })
      .select("id")
      .single();

    if (outcomeErr) {
      console.error("[record-flight-outcome] upsert failed", outcomeErr);
      return json({ error: outcomeErr.message }, 500);
    }

    // ── 2. Mark flight_intent as completed/landed (trigger archives it) ─
    await supabase
      .from("flight_intents")
      .update({ status: "landed", landed_at: actual_arrival_time })
      .eq("id", flight_intent_id);

    // ── 3. Update OD pattern's outcome-adjusted score & systematic error ─
    const { data: intent } = await supabase
      .from("flight_intents")
      .select("origin, destination")
      .eq("id", flight_intent_id)
      .single();

    let patternAdjustment = 0;
    let predictionError = 0;
    if (intent?.origin && intent?.destination) {
      const originKey = intent.origin.toLowerCase().split("@")[0].trim();
      const destKey = intent.destination.toLowerCase().split("@")[0].trim();

      // Adjustment scoring:
      //   on-time arrival: +2
      //   each minute over plan: -0.5 (capped at -10)
      //   each high-severity issue: -5
      //   each moderate issue: -2
      let adjustment = 2 - Math.min(10, Math.max(0, delay_minutes) * 0.5);
      for (const issue of (issues_encountered ?? [])) {
        adjustment += issue.severity === "high" ? -5 : issue.severity === "moderate" ? -2 : -0.5;
      }
      adjustment -= reroute_count * 3;
      patternAdjustment = adjustment;

      const { data: pattern } = await supabase
        .from("route_patterns")
        .select("*")
        .eq("origin_key", originKey)
        .eq("destination_key", destKey)
        .maybeSingle();

      if (pattern) {
        const completedCount = (pattern.completed_flight_count ?? 0) + 1;
        const avgDelay =
          ((Number(pattern.avg_actual_delay_minutes ?? 0)) * (pattern.completed_flight_count ?? 0) +
            Number(delay_minutes)) /
          completedCount;
        const avgActualDuration =
          ((Number(pattern.avg_actual_duration_minutes ?? actual_duration_minutes)) *
            (pattern.completed_flight_count ?? 0) +
            Number(actual_duration_minutes)) /
          completedCount;
        const baseScore = Number(pattern.outcome_adjusted_score ?? pattern.avg_overall_score ?? 70);
        const adjusted = Math.max(10, Math.min(100, baseScore + adjustment));
        // Systematic error: signed bias between prediction and outcome.
        const sysErr = predicted_overall_score != null
          ? (Number(pattern.systematic_error ?? 0) * (pattern.completed_flight_count ?? 0) +
              (adjusted - Number(predicted_overall_score))) / completedCount
          : Number(pattern.systematic_error ?? 0);
        predictionError = sysErr;

        await supabase
          .from("route_patterns")
          .update({
            completed_flight_count: completedCount,
            avg_actual_delay_minutes: avgDelay,
            avg_actual_duration_minutes: avgActualDuration,
            outcome_adjusted_score: adjusted,
            systematic_error: sysErr,
            last_updated: new Date().toISOString(),
          })
          .eq("id", pattern.id);
      }
    }

    // ── 4. Self-correct global weights (when patterns drift) ────────────
    // This is the closed loop: if many OD pairs show "predicted overall too
    // high but actual delays/issues bring them down", we nudge weight_time and
    // weight_safety up so future predictions are more cautious. The opposite
    // case nudges them down. We rate-limit by `learning_rate` to avoid oscillation.
    if (predicted_overall_score != null) {
      const { data: cfg } = await supabase
        .from("route_score_config")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cfg) {
        const learningRate = Number(cfg.learning_rate ?? 0.05);
        const seenBefore = Number(cfg.total_outcomes_seen ?? 0);
        // Direction of correction: positive sysErr (predicted lower than actual)
        // means we're being too pessimistic — relax safety/time weight a touch.
        // Negative sysErr means we're being optimistic — increase safety/time.
        const direction = Math.sign(predictionError);
        if (direction !== 0 && Math.abs(predictionError) > 3) {
          const stepSafety = direction < 0 ? +learningRate * 0.4 : -learningRate * 0.2;
          const stepTime   = direction < 0 ? +learningRate * 0.4 : -learningRate * 0.2;
          const stepEff    = direction < 0 ? -learningRate * 0.2 : +learningRate * 0.2;
          const stepFuel   = direction < 0 ? -learningRate * 0.2 : +learningRate * 0.2;

          const clamp = (v: number) => Math.max(0.05, Math.min(0.45, v));
          const newSafety = clamp(Number(cfg.weight_safety) + stepSafety);
          const newTime   = clamp(Number(cfg.weight_time   ?? 0.20) + stepTime);
          const newEff    = clamp(Number(cfg.weight_efficiency) + stepEff);
          const newFuel   = clamp(Number(cfg.weight_fuel   ?? 0.10) + stepFuel);

          await supabase
            .from("route_score_config")
            .update({
              weight_safety: newSafety,
              weight_time: newTime,
              weight_efficiency: newEff,
              weight_fuel: newFuel,
              total_outcomes_seen: seenBefore + 1,
              updated_at: new Date().toISOString(),
            })
            .eq("id", cfg.id);
        } else {
          await supabase
            .from("route_score_config")
            .update({ total_outcomes_seen: seenBefore + 1, updated_at: new Date().toISOString() })
            .eq("id", cfg.id);
        }
      }
    }

    return json({
      outcome_id: outcomeRow?.id ?? null,
      decision_accuracy: decisionAccuracy,
      duration_delta_minutes: Math.round(durationDelta * 10) / 10,
      pattern_score_adjustment: Math.round(patternAdjustment * 100) / 100,
      systematic_error: Math.round(predictionError * 100) / 100,
      recorded_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[record-flight-outcome] unhandled", err);
    return json({ error: String(err) }, 500);
  }
});
