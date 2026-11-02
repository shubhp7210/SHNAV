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
  "vertiport-coordinator", "trajectory-predictor", "weather-intelligence", "record-flight-outcome"];
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const rest = (path, init = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: KEY, "Content-Type": "application/json", ...(init.headers ?? {}) } });

// 1. Migration applied: anon must be DENIED (permission), not "table not found".
for (const t of ["rate_limits", "error_events", "api_usage", "geocode_cache"]) {
  const r = await rest(`${t}?select=*&limit=1`);
  const body = await r.text();
  check(`table ${t} exists and is private`, r.status === 401 || r.status === 403 || /permission denied/i.test(body), `${r.status} ${body.slice(0, 80)}`);
}
// 2. Privileged RPCs refuse the anon role.
for (const fn of ["check_rate_limit", "reserve_airspace_slot", "record_flight_outcome_tx", "expire_stale_intents"]) {
  const r = await rest(`rpc/${fn}`, { method: "POST", body: "{}" });
  const body = await r.text();
  check(`rpc ${fn} denied to anon`, r.status === 401 || r.status === 403 || /permission denied/i.test(body), `${r.status} ${body.slice(0, 80)}`);
}
// 3. Anonymous reads of user data return nothing (RLS).
for (const t of ["flight_intents", "flight_decisions", "routes", "historical_flights"]) {
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
