// Records a completed flight and feeds the learning loop.
//
// All writes run inside public.record_flight_outcome_tx() — one transaction
// with row locks and an insert-once guard. The previous version made 8+
// sequential requests with read-modify-write updates, so concurrent landings
// lost updates and a replayed call could double-count an outcome.
import { serve, httpError } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody, validateFields } from "../_shared/validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

serve("record-flight-outcome", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);
  const rl = await checkRateLimit(admin, user.id, "record-flight-outcome", 20, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const raw = await readBody(req) as Record<string, unknown>;
  validateFields(raw, {
    flight_intent_id:       { required: true, type: "string", pattern: UUID },
    aircraft_id:            { required: true, type: "string", maxLength: 32 },
    route_id:               { type: "string", maxLength: 64 },
    decision_id:            { type: "string", pattern: UUID },
    planned_departure_time: { type: "string", pattern: ISO },
    actual_departure_time:  { type: "string", pattern: ISO },
    planned_arrival_time:   { type: "string", pattern: ISO },
    actual_arrival_time:    { type: "string", pattern: ISO },
    predicted_weather_risk: { type: "string", oneOf: ["low", "moderate", "high", "unknown"] },
    completion_status:      { type: "string", oneOf: ["completed", "aborted", "diverted"] },
  });
  for (const k of ["planned_duration_minutes", "actual_duration_minutes", "delay_minutes", "predicted_overall_score", "reroute_count"]) {
    const v = raw[k];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000)) {
      throw httpError(400, "Validation failed", { details: [`${k}: must be a non-negative number`] });
    }
  }
  if (raw.issues_encountered != null && (!Array.isArray(raw.issues_encountered) || raw.issues_encountered.length > 50)) {
    throw httpError(400, "Validation failed", { details: ["issues_encountered: must be an array (≤50)"] });
  }

  const { data, error } = await admin.rpc("record_flight_outcome_tx", {
    p_user: user.id, p_intent: raw.flight_intent_id, p: raw,
  });
  if (error) throw new Error(`record_flight_outcome_tx failed: ${error.message}`);
  if (data?.error === "not_found") throw httpError(403, "Flight intent not found or access denied");
  return json(data);
});
