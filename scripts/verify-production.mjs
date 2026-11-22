// Post-deploy smoke test against the LIVE project using only the public anon
// key (read-only, no user data touched). Fails if production is not running
// the hardened backend.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... ALLOWED_ORIGIN=https://app.example node scripts/verify-production.mjs
const URL_ = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const ORIGIN = process.env.ALLOWED_ORIGIN;
if (!URL_ || !KEY) { console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required"); process.exit(2); }

const FUNCTIONS = ["trajectory-analysis", "route-optimizer", "flight-decision-engine", "airspace-scheduler",
  "vertiport-coordinator", "trajectory-predictor", "weather-intelligence", "record-flight-outcome", "flight-telemetry"];
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const rest = (path, init = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: KEY, "Content-Type": "application/json", ...(init.headers ?? {}) } });

// 1. Migration applied: anon must be DENIED (permission), not "table not found".
for (const t of ["rate_limits", "error_events", "api_usage", "geocode_cache",
  // 2026-11-15 data platform: observations need sign-in; ops/learning tables are private.
  "data_sources", "ingest_runs", "model_params", "record_corrections", "wx_verification", "wx_metar", "traffic_observations",
  // 2026-11-22 admin tracking: never readable without signing in.
  "admins", "vehicles", "flights", "location_pings"]) {
  const r = await rest(`${t}?select=*&limit=1`);
  const body = await r.text();
  check(`table ${t} exists and is private`, r.status === 401 || r.status === 403 || /permission denied/i.test(body), `${r.status} ${body.slice(0, 80)}`);
}
// 2. Privileged RPCs refuse the anon role.
// Pass each function's real parameter names (all null): with "{}" PostgREST cannot resolve the
// overload and answers 404 "function not found" before it ever checks privileges, so the check
// failed against a correctly locked-down production.
const RPC_ARGS = {
  check_rate_limit: ["p_user_id", "p_bucket", "p_limit", "p_window_seconds"],
  reserve_airspace_slot: ["p_intent", "p_aircraft", "p_band", "p_start", "p_priority", "p_emergency"],
  record_flight_outcome_tx: ["p_user", "p_intent", "p"],
  expire_stale_intents: [],
  ingest_claim: ["p_source", "p_force"],
  ingest_telemetry: ["p_user", "p_intent", "p_points"],
  finalize_flight: ["p_intent", "p_force"],
  apply_correction: ["p_table", "p_id", "p_field", "p_value", "p_reason", "p_evidence", "p_actor"],
  run_learning_cycle: [],
  train_duration_calibration: [],
  tracker_ping: ["p_token", "p_lat", "p_lng", "p_alt", "p_speed", "p_heading", "p_accuracy", "p_t"],
};
for (const [fn, args] of Object.entries(RPC_ARGS)) {
  const r = await rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(Object.fromEntries(args.map((a) => [a, null]))) });
  const body = await r.text();
  check(`rpc ${fn} denied to anon`, r.status === 401 || r.status === 403 || /permission denied/i.test(body), `${r.status} ${body.slice(0, 80)}`);
}
// 3. Anonymous reads of user data return nothing (RLS).
for (const t of ["flight_intents", "flight_decisions", "routes", "historical_flights", "past_flights", "user_pattern_flags", "flight_telemetry"]) {
  const r = await rest(`${t}?select=id&limit=1`);
  const rows = r.ok ? await r.json() : [];
  check(`RLS hides ${t} from anon`, Array.isArray(rows) && rows.length === 0, `${r.status}`);
}
// 4. Real vertiports are active.
{
  const r = await rest("vertiports?select=faa_id&is_active=eq.true");
  const ids = r.ok ? (await r.json()).map((v) => v.faa_id).sort() : [];
  check("FAA vertiports active", ["6N5", "EWR", "JFK", "JRA", "JRB", "LGA"].every((id) => ids.includes(id)), ids.join(","));
}
// 5. Gateway JWT verification on user functions (gateway message, not in-code).
for (const fn of FUNCTIONS) {
  const r = await fetch(`${URL_}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await r.text();
  check(`${fn} rejects unauthenticated calls`, r.status === 401, `${r.status} ${body.slice(0, 60)}`);
}
// 5b. The ingestion endpoint is server-to-server only: no secret → 403.
{
  const r = await fetch(`${URL_}/functions/v1/data-ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("data-ingest refuses calls without the internal secret", r.status === 403, `${r.status}`);
}
// 5c. Tracker intake: no JWT at the gateway, but no/unknown device token → 401.
{
  const none = await fetch(`${URL_}/functions/v1/ping`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("ping refuses calls without a device token", none.status === 401, `${none.status}`);
  const bad = await fetch(`${URL_}/functions/v1/ping`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Token": "0".repeat(64) }, body: JSON.stringify({ lat: 0, lng: 0 }) });
  check("ping refuses unknown device tokens", bad.status === 401, `${bad.status}`);
}
// 6. CORS is not wildcard and echoes only the allowed origin.
{
  const evil = await fetch(`${URL_}/functions/v1/weather-intelligence`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  const acao = evil.headers.get("access-control-allow-origin");
  check("CORS refuses foreign origins", acao !== "*" && acao !== "https://evil.example", `ACAO=${acao}`);
  if (ORIGIN) {
    const good = await fetch(`${URL_}/functions/v1/weather-intelligence`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    check("CORS allows the app origin", good.headers.get("access-control-allow-origin") === ORIGIN, `ACAO=${good.headers.get("access-control-allow-origin")}`);
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
