// Single GO / DELAY / REROUTE decision for a filed flight.
//
// Inputs are assembled SERVER-SIDE from records the caller owns — trajectory
// analysis, airspace + vertiport reservations, the saved route candidates —
// plus a fresh departure-time weather forecast. Client-supplied scores are
// ignored (they were previously trusted, so a modified client could save a GO).
//
// Persistence fix: flight_decisions.route_id is a uuid FK to routes(id), but the
// old code wrote candidate ids like "port-wide" into it, so every REROUTE
// decision failed to save silently. The routes row id and the candidate id are
// now stored separately, and the insert error is checked.
import { serve, httpError } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody, validateFields } from "../_shared/validate.ts";
import { departureRisk } from "../_shared/weather.ts";
import { decide, type DecisionInputs, type RouteAlt } from "../_shared/decision.ts";
import { logInfo } from "../_shared/log.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRESH_MS = 30 * 60_000;

interface Candidate { id: string; label: string; overall_score?: number; traffic_score?: number }

serve("flight-decision-engine", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);
  const rl = await checkRateLimit(admin, user.id, "flight-decision-engine", 30, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const raw = await readBody(req);
  const body = validateFields(raw, {
    flight_intent_id:      { required: true, type: "string", maxLength: 36, pattern: UUID },
    selected_candidate_id: { type: "string", maxLength: 64, pattern: /^[a-z0-9-]+$/ },
  }) as { flight_intent_id: string; selected_candidate_id?: string };

  const { data: fi } = await admin.from("flight_intents")
    .select("id, aircraft_id, status, altitude_band, trajectory_score, conflicts, weather_risk, analysis_result, departure_start_at, origin_lat, origin_lon, airspace_assessment, vertiport_assessment")
    .eq("id", body.flight_intent_id).eq("user_id", user.id).maybeSingle();
  if (!fi) throw httpError(403, "Flight intent not found or access denied");
  if (!fi.departure_start_at || !fi.analysis_result) throw httpError(409, "Run trajectory analysis before requesting a decision");
  if (["expired", "archived", "landed"].includes(fi.status)) throw httpError(409, `Flight is ${fi.status}`);
  const departureStart = new Date(fi.departure_start_at);

  // Saved optimizer output for this flight (most recent run).
  const { data: routeRow } = await admin.from("routes")
    .select("id, primary_route, alternate_routes, overall_score")
    .eq("flight_intent_id", fi.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  let route: DecisionInputs["route"] = null;
  if (routeRow?.primary_route) {
    const all: Candidate[] = [routeRow.primary_route as Candidate, ...((routeRow.alternate_routes ?? []) as Candidate[])];
    const chosen = all.find((c) => c.id === body.selected_candidate_id) ?? all[0];
    route = {
      primaryId: chosen.id,
      primaryScore: Number(chosen.overall_score ?? routeRow.overall_score ?? fi.trajectory_score),
      alternates: all.filter((c) => c !== chosen).map((c): RouteAlt => ({ id: c.id, label: c.label, traffic_score: c.traffic_score })),
    };
  }

  // Reservations are only trusted when fresh.
  const fresh = (a: { computed_at?: string } | null) => !!a?.computed_at && Date.now() - new Date(a.computed_at).getTime() < FRESH_MS;
  const as = fresh(fi.airspace_assessment) ? fi.airspace_assessment : null;
  const vs = fresh(fi.vertiport_assessment) ? fi.vertiport_assessment : null;

  const weather = fi.origin_lat != null
    ? await departureRisk(fi.origin_lat, fi.origin_lon, departureStart, fi.altitude_band ?? "low")
    : { available: false as const };

  const { data: profile } = await admin.from("user_error_profiles")
    .select("confidence_adjustment").eq("user_id", user.id).maybeSingle();
  const userAdj = Number(profile?.confidence_adjustment ?? 0);

  const inputs: DecisionInputs = {
    trajectoryScore: Number(fi.trajectory_score ?? 0),
    conflicts: Number(fi.conflicts ?? 0),
    conflictCheck: fi.analysis_result?.conflict_check?.status ?? null,
    weather: weather.available
      ? { available: true, riskScore: weather.riskScore, forecast15: weather.forecast15, forecast30: weather.forecast30, trend: weather.trend }
      : { available: false },
    airspace: as ? { allocated: !!as.allocated, delayMinutes: as.delay_minutes, loadPct: Number(as.load_percentage ?? 0) } : null,
    vertiport: vs ? { checked: !!vs.checked, reserved: !!vs.reserved, delayMinutes: vs.delay_minutes } : null,
    route,
    departureStart,
    userConfidenceAdj: userAdj,
  };
  const out = decide(inputs);

  const { data: saved, error: saveErr } = await admin.from("flight_decisions").insert({
    flight_intent_id: fi.id,
    aircraft_id: fi.aircraft_id,
    decision: out.decision,
    reason: out.reason,
    confidence: out.confidence,
    departure_time: out.departureTime.toISOString(),
    delay_minutes: out.delayMinutes,
    route_id: routeRow?.id ?? null,
    route_candidate_id: out.routeCandidateId,
    weather_risk: weather.available ? (weather.riskScore >= 60 ? "high" : weather.riskScore >= 30 ? "moderate" : "low") : "unknown",
    airspace_load: inputs.airspace?.loadPct ?? null,
    simulation_result: out.simulation,
    inputs: { ...inputs, departureStart: departureStart.toISOString(), weather_valid_at: weather.available ? weather.validAt : null },
  }).select("id").single();
  if (saveErr) throw new Error(`flight_decisions insert failed: ${saveErr.message}`);

  logInfo("flight-decision-engine", "decided", { intent: fi.id, decision: out.decision, confidence: out.confidence });

  return json({
    decision_id: saved.id,
    decision: out.decision,
    reason: out.reason,
    confidence: out.confidence,
    departure_time: out.departureTime.toISOString(),
    delay_minutes: out.delayMinutes,
    route_id: out.routeCandidateId,
    simulation: out.simulation,
    data_quality: out.notes,
    user_confidence_adjustment: userAdj,
    inputs_summary: {
      trajectory_score: inputs.trajectoryScore,
      weather_risk: weather.available ? (weather.riskScore >= 60 ? "high" : weather.riskScore >= 30 ? "moderate" : "low") : "unknown",
      weather_risk_score: weather.available ? weather.riskScore : null,
      conflicts: inputs.conflicts,
      airspace_load: inputs.airspace?.loadPct ?? null,
      vertiport_delay: inputs.vertiport?.delayMinutes ?? null,
      route_score: route?.primaryScore ?? null,
      forecast_trend: weather.available ? weather.trend : "unknown",
    },
  });
});
