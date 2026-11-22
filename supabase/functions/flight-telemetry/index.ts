// GPS telemetry intake for an airborne flight. The client batches fixes; the
// database validates each one (ownership, airborne state, timestamps,
// accuracy, physically plausible movement) inside ingest_telemetry(), which
// locks the flight row so concurrent batches cannot interleave.
//
// Only telemetry received here can make a past flight "verified" — client
// claims about duration or arrival are never trusted on their own.
import { serve, httpError } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody } from "../_shared/validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_POINTS = 120;

serve("flight-telemetry", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);
  const rl = await checkRateLimit(admin, user.id, "flight-telemetry", 120, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const body = await readBody(req) as { flight_intent_id?: unknown; points?: unknown };
  if (typeof body.flight_intent_id !== "string" || !UUID.test(body.flight_intent_id)) {
    throw httpError(400, "Validation failed", { details: ["flight_intent_id: must be a UUID"] });
  }
  if (!Array.isArray(body.points) || body.points.length === 0 || body.points.length > MAX_POINTS) {
    throw httpError(400, "Validation failed", { details: [`points: 1–${MAX_POINTS} fixes required`] });
  }
  const points = body.points.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { t: typeof o.t === "string" ? o.t.slice(0, 40) : null, lat: n(o.lat), lon: n(o.lon),
             acc: n(o.acc), spd: n(o.spd), hdg: n(o.hdg), alt: n(o.alt) };
  });

  const { data, error } = await admin.rpc("ingest_telemetry", {
    p_user: user.id, p_intent: body.flight_intent_id, p_points: points,
  });
  if (error) throw new Error(`ingest_telemetry failed: ${error.message}`);
  if (data?.error === "not_found") throw httpError(403, "Flight intent not found or access denied");
  if (data?.error === "not_airborne") throw httpError(409, `Flight is not airborne (status ${data.status})`);
  return json(data);
});
