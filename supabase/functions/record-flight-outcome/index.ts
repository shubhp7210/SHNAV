// Captures an actual flight outcome, classifies it against the prediction,
// updates the OD-pair's running outcome-adjusted score, nudges global scoring
// weights, and updates the user's error profile for confidence calibration.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";


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
  if (deltaMin > 5) return "optimistic";
  if (deltaMin < -5) return "pessimistic";
  return "accurate";
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const user = await requireUserAuth(req);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
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

    // Ownership check — prevent users from marking other operators' flights as landed.
    const { data: ownedIntent } = await supabase
      .from("flight_intents")
      .select("id, origin, destination, altitude_band")
      .eq("id", flight_intent_id)
      .eq("user_id", user.id)
      .single();

    if (!ownedIntent) {
      return json({ error: "Flight intent not found or access denied" }, 403);
    }

    // Replay guard — an outcome is recorded once. Without this, re-POSTing the
    // same flight inflates pattern counts, user-profile totals, and the weight
    // self-correction on every call.
    const { data: existingOutcome } = await supabase
      .from("flight_outcomes")
      .select("id, decision_accuracy")
      .eq("flight_intent_id", flight_intent_id)
      .maybeSingle();
    if (existingOutcome) {
      return json({
        outcome_id: existingOutcome.id,
        decision_accuracy: existingOutcome.decision_accuracy,
        already_recorded: true,
      });
    }

    const durationDelta = planned_duration_minutes != null
      ? Number(actual_duration_minutes) - Number(planned_duration_minutes)
      : 0;
    const decisionAccuracy = classifyAccuracy(durationDelta);

    // ── 1. Upsert outcome ──────────────────────────────────────────────────
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

    // ── 2. Mark flight_intent as landed (trigger archives it) ─────────────
    await supabase
      .from("flight_intents")
      .update({ status: "landed", landed_at: actual_arrival_time })
      .eq("id", flight_intent_id);

    // ── 3. Update OD pattern's outcome-adjusted score ─────────────────────
    const originKey = ownedIntent.origin.toLowerCase().split("@")[0].trim();
    const destKey = ownedIntent.destination.toLowerCase().split("@")[0].trim();
    const band = ownedIntent.altitude_band ?? "low";

    let patternAdjustment = 0;
    let predictionError = 0;

    const { data: pattern } = await supabase
      .from("route_patterns")
      .select("*")
      .eq("origin_key", originKey)
      .eq("destination_key", destKey)
      .eq("altitude_band", band)
      .is("user_id", null)
      .maybeSingle();

    if (pattern) {
      const completedCount = (pattern.completed_flight_count ?? 0) + 1;
      const avgDelay =
        ((Number(pattern.avg_actual_delay_minutes ?? 0)) * (pattern.completed_flight_count ?? 0) +
          Number(delay_minutes)) / completedCount;
      const avgActualDuration =
        ((Number(pattern.avg_actual_duration_minutes ?? actual_duration_minutes)) *
          (pattern.completed_flight_count ?? 0) + Number(actual_duration_minutes)) / completedCount;

      let adjustment = 2 - Math.min(10, Math.max(0, delay_minutes) * 0.5);
      for (const issue of (issues_encountered ?? [])) {
        adjustment += issue.severity === "high" ? -5 : issue.severity === "moderate" ? -2 : -0.5;
      }
      adjustment -= reroute_count * 3;
      patternAdjustment = adjustment;

      const baseScore = Number(pattern.outcome_adjusted_score ?? pattern.avg_overall_score ?? 70);
      const adjusted = Math.max(10, Math.min(100, baseScore + adjustment));
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

    // ── 4. Update user-specific pattern ───────────────────────────────────
    const { data: userPattern } = await supabase
      .from("route_patterns")
      .select("*")
      .eq("origin_key", originKey)
      .eq("destination_key", destKey)
      .eq("altitude_band", band)
      .eq("user_id", user.id)
      .maybeSingle();

    if (userPattern) {
      const n = (userPattern.completed_flight_count ?? 0) + 1;
      const avgDelay =
        ((Number(userPattern.avg_actual_delay_minutes ?? 0)) * (userPattern.completed_flight_count ?? 0) +
          Number(delay_minutes)) / n;
      let adj = 2 - Math.min(10, Math.max(0, delay_minutes) * 0.5);
      for (const issue of (issues_encountered ?? [])) {
        adj += issue.severity === "high" ? -5 : issue.severity === "moderate" ? -2 : -0.5;
      }
      adj -= reroute_count * 3;
      const base = Number(userPattern.outcome_adjusted_score ?? userPattern.avg_overall_score ?? 70);
      await supabase
        .from("route_patterns")
        .update({
          completed_flight_count: n,
          avg_actual_delay_minutes: avgDelay,
          outcome_adjusted_score: Math.max(10, Math.min(100, base + adj)),
          last_updated: new Date().toISOString(),
        })
        .eq("id", userPattern.id);
    }

    // ── 5. Self-correct global weights ────────────────────────────────────
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
        const direction = Math.sign(predictionError);
        if (direction !== 0 && Math.abs(predictionError) > 3) {
          const stepSafety = direction < 0 ? +learningRate * 0.4 : -learningRate * 0.2;
          const stepTime   = direction < 0 ? +learningRate * 0.4 : -learningRate * 0.2;
          const stepEff    = direction < 0 ? -learningRate * 0.2 : +learningRate * 0.2;
          const stepFuel   = direction < 0 ? -learningRate * 0.2 : +learningRate * 0.2;
          const clamp = (v: number) => Math.max(0.05, Math.min(0.45, v));
          await supabase
            .from("route_score_config")
            .update({
              weight_safety:     clamp(Number(cfg.weight_safety) + stepSafety),
              weight_time:       clamp(Number(cfg.weight_time ?? 0.20) + stepTime),
              weight_efficiency: clamp(Number(cfg.weight_efficiency) + stepEff),
              weight_fuel:       clamp(Number(cfg.weight_fuel ?? 0.10) + stepFuel),
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

    // ── 6. Update user error profile for confidence calibration ───────────
    const { data: profile } = await supabase
      .from("user_error_profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    const highSeverityCount = (issues_encountered ?? []).filter(i => i.severity === "high").length;
    const totalAnomalies = (issues_encountered ?? []).length;

    if (profile) {
      const newTotal = profile.total_flights + 1;
      const newTotalAnomalies = profile.total_anomalies + totalAnomalies;
      const newHighSeverity = profile.high_severity_anomalies + highSeverityCount;
      const newAvgDelay = (profile.avg_delay_minutes * profile.total_flights + Number(delay_minutes)) / newTotal;
      const newRerouteRate = (profile.reroute_rate * profile.total_flights + reroute_count) / newTotal;
      const anomalyRate = newTotalAnomalies / newTotal;
      // Confidence adjustment: each 10% anomaly rate → -2 pts, capped at -20.
      const confidenceAdj = Math.max(-20, -(anomalyRate * 20));

      const newAccurate = profile.accuracy_accurate + (decisionAccuracy === "accurate" ? 1 : 0);
      const newOptimistic = profile.accuracy_optimistic + (decisionAccuracy === "optimistic" ? 1 : 0);
      const newPessimistic = profile.accuracy_pessimistic + (decisionAccuracy === "pessimistic" ? 1 : 0);

      await supabase
        .from("user_error_profiles")
        .update({
          total_flights: newTotal,
          total_anomalies: newTotalAnomalies,
          high_severity_anomalies: newHighSeverity,
          avg_delay_minutes: newAvgDelay,
          reroute_rate: newRerouteRate,
          accuracy_accurate: newAccurate,
          accuracy_optimistic: newOptimistic,
          accuracy_pessimistic: newPessimistic,
          anomaly_rate: anomalyRate,
          confidence_adjustment: confidenceAdj,
          last_updated: new Date().toISOString(),
        })
        .eq("user_id", user.id);
    } else {
      const anomalyRate = totalAnomalies;
      await supabase
        .from("user_error_profiles")
        .insert({
          user_id: user.id,
          total_flights: 1,
          total_anomalies: totalAnomalies,
          high_severity_anomalies: highSeverityCount,
          avg_delay_minutes: Number(delay_minutes),
          reroute_rate: reroute_count,
          accuracy_accurate: decisionAccuracy === "accurate" ? 1 : 0,
          accuracy_optimistic: decisionAccuracy === "optimistic" ? 1 : 0,
          accuracy_pessimistic: decisionAccuracy === "pessimistic" ? 1 : 0,
          anomaly_rate: anomalyRate,
          confidence_adjustment: Math.max(-20, -(anomalyRate * 20)),
        });
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
    if (err instanceof Response) return err;
    console.error("[record-flight-outcome] unhandled", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
