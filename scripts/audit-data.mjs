// READ-ONLY data audit of a SHNAV database (production or staging).
//
//   DATABASE_URL=postgres://… node scripts/audit-data.mjs [--out report.md] [--export dir]
//
// - The session is forced read-only (default_transaction_read_only = on), so
//   no check can modify data.
// - Works on both the July production schema and the 2026-11-15 data platform:
//   a check whose table/column does not exist is reported as "n/a".
// - --export writes every audited table to <dir>/<table>.json (a backup to keep
//   BEFORE applying 20261115000000_data_platform.sql; the migration also copies
//   learned state to schema archive_20261115).
import pg from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!url) { console.error("DATABASE_URL (or SUPABASE_DB_URL) is required"); process.exit(2); }
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const outFile = arg("--out");
const exportDir = arg("--export");

const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query("SET default_transaction_read_only = on");
await db.query("SET statement_timeout = '60s'");

const findings = [];
/** severity: critical = wrong values used in calculations; high = integrity; medium = data quality; info. */
async function check(area, title, severity, sql, explain) {
  try {
    const r = await db.query(sql);
    const n = Number(r.rows[0]?.n ?? r.rowCount ?? 0);
    const sample = r.rows[0]?.sample ?? null;
    findings.push({ area, title, severity, n, sample, explain, status: n > 0 ? "issue" : "ok" });
  } catch (e) {
    findings.push({ area, title, severity, n: null, explain, status: "n/a", error: e.message.split("\n")[0] });
  }
}
const S = (q, cols = "id") => `SELECT count(*)::int n, (SELECT jsonb_agg(${cols}) FROM (${q} LIMIT 5) s) sample FROM (${q}) z`;

// ── Flights ─────────────────────────────────────────────────────────────────
await check("flights", "Flights with no absolute departure time", "high",
  S(`SELECT id FROM flight_intents WHERE departure_start_at IS NULL`),
  "Old rows only have HH:MM text; they cannot be time-aligned with weather or traffic.");
await check("flights", "Flights without resolved coordinates", "high",
  S(`SELECT id FROM flight_intents WHERE origin_lat IS NULL OR dest_lat IS NULL`),
  "Conflict checks skip these; any learning from them would be position-free.");
await check("flights", "Departure window end before start", "high",
  S(`SELECT id FROM flight_intents WHERE departure_end_at < departure_start_at`), "Impossible window.");
await check("flights", "Trajectory score outside 0–100", "critical",
  S(`SELECT id FROM flight_intents WHERE trajectory_score < 0 OR trajectory_score > 100`), "Pre-clamp scores.");
await check("flights", "Duplicate filings (same user, aircraft, departure)", "medium",
  S(`SELECT min(id::text) id FROM flight_intents WHERE departure_start_at IS NOT NULL GROUP BY user_id, aircraft_id, departure_start_at HAVING count(*) > 1`),
  "Likely double-submits before the idempotency key existed.");
await check("flights", "Airborne for more than 12 h", "high",
  S(`SELECT id FROM flight_intents WHERE status IN ('in_air','active') AND COALESCE(departure_end_at, created_at) < now() - interval '12 hours'`),
  "Never landed / never expired — would block capacity and look like live traffic.");
await check("flights", "Same aircraft airborne twice", "high",
  S(`SELECT aircraft_id AS id FROM flight_intents WHERE status IN ('in_air','active') GROUP BY aircraft_id HAVING count(*) > 1`), "");
await check("flights", "Landed/archived with no recorded outcome", "info",
  S(`SELECT fi.id FROM flight_intents fi WHERE fi.status IN ('landed','archived') AND NOT EXISTS (SELECT 1 FROM flight_outcomes o WHERE o.flight_intent_id = fi.id)`),
  "Simulated runs (expected) or failed outcome calls.");

// ── Routes ──────────────────────────────────────────────────────────────────
await check("routes", "Route scores outside 0–100", "critical",
  S(`SELECT id FROM routes WHERE overall_score > 100 OR overall_score < 0 OR safety_score > 100 OR weather_score > 100 OR traffic_score > 100 OR efficiency_score > 100`),
  "Fuel score exceeded 100 on tailwinds before clampScore — these values fed pattern averages.");
await check("routes", "Estimated time inconsistent with distance at 90 km/h (>50%)", "medium",
  S(`SELECT id FROM routes WHERE (primary_route->>'distance_km')::numeric > 0 AND (primary_route->>'estimated_time_min')::numeric > 0
     AND abs((primary_route->>'estimated_time_min')::numeric - (primary_route->>'distance_km')::numeric / 90 * 60)
         / ((primary_route->>'distance_km')::numeric / 90 * 60) > 0.5`), "Calculation drift between versions.");
await check("routes", "Weather stored for routes with no forecast (calm placeholders)", "critical",
  S(`SELECT id FROM routes WHERE weather_conditions IS NOT NULL AND (weather_conditions->>'wind_speed')::numeric = 0
     AND (weather_conditions->>'wind_gusts')::numeric = 0 AND (weather_conditions->>'temperature') IS NULL`),
  "Zeros from an unavailable forecast stored as if observed calm.");

// ── Outcomes / learning ─────────────────────────────────────────────────────
await check("learning", "Outcomes with experienced wind/deviation coerced to 0", "critical",
  S(`SELECT id FROM flight_outcomes WHERE experienced_max_wind_kmh = 0 AND experienced_max_gusts_kmh = 0 AND experienced_route_deviation_m = 0`),
  "COALESCE(...,0) recorded missing measurements as 'calm, on track'.");
await check("learning", "Outcomes with zero or implausible duration", "critical",
  S(`SELECT id FROM flight_outcomes WHERE actual_duration_minutes <= 0.5 OR actual_duration_minutes > 600`),
  "Includes 48-second simulated runs recorded before the GPS-only guard.");
await check("learning", "Route patterns carrying circular 'outcome-adjusted' scores", "critical",
  S(`SELECT id FROM route_patterns WHERE outcome_adjusted_score IS NOT NULL OR systematic_error <> 0`),
  "Adjusted score = heuristic vs prediction, not observation — no real outcome information.");
await check("learning", "Scoring weights drifted from configured defaults", "critical",
  S(`SELECT id FROM route_score_config WHERE abs(weight_safety - 0.35) > 0.001 OR COALESCE(total_outcomes_seen,0) > 0`),
  "Weights were nudged per flight with no holdout validation.");
await check("learning", "Users with a silent confidence penalty", "critical",
  S(`SELECT user_id AS id FROM user_error_profiles WHERE confidence_adjustment <> 0`, "id"),
  "Applied to decisions without telling or asking the user.");
await check("learning", "Route patterns whose flight_count disagrees with stored routes", "medium",
  S(`SELECT rp.id FROM route_patterns rp WHERE rp.user_id IS NULL AND rp.flight_count <> (
       SELECT count(*) FROM routes r WHERE od_key(r.origin) = rp.origin_key AND od_key(r.destination) = rp.destination_key AND r.altitude_band = rp.altitude_band)`),
  "Overwritten counts (fixed 2026-07) or pruned routes.");

// ── Reservations / decisions ────────────────────────────────────────────────
await check("ops", "Orphan airspace slots", "medium",
  S(`SELECT ts.id FROM time_slots ts WHERE flight_intent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM flight_intents fi WHERE fi.id = ts.flight_intent_id)`), "");
await check("ops", "Active slots held by ended flights", "high",
  S(`SELECT ts.id FROM time_slots ts JOIN flight_intents fi ON fi.id = ts.flight_intent_id WHERE fi.status IN ('archived','expired','landed') AND ts.status IN ('allocated','active')`),
  "Capacity held by flights that are over.");
await check("ops", "Multiple current decisions for one flight", "medium",
  S(`SELECT flight_intent_id AS id FROM flight_decisions WHERE NOT superseded GROUP BY flight_intent_id HAVING count(*) > 1`), "");
await check("ops", "GO decisions issued with unknown weather", "critical",
  S(`SELECT id FROM flight_decisions WHERE decision = 'GO' AND (weather_risk IS NULL OR weather_risk = 'unknown')`), "");
await check("ops", "Fictional vertiports still active", "high",
  S(`SELECT id FROM vertiports WHERE is_active AND name IN ('Downtown Vertiport','Airport Vertiport North','Bay Vertiport','Uptown Hub','East Corridor Hub')`),
  "'Airport Vertiport North' sits in Times Square.");

// ── History ─────────────────────────────────────────────────────────────────
await check("history", "historical_flights rows without a flight record", "info",
  S(`SELECT h.id FROM historical_flights h WHERE NOT EXISTS (SELECT 1 FROM flight_intents fi WHERE fi.id = h.flight_intent_id)`),
  "Preserved into past_flights as legacy by the data-platform migration.");
await check("history", "historical_flights with score outside 0–100", "medium",
  S(`SELECT id FROM historical_flights WHERE trajectory_score < 0 OR trajectory_score > 100`), "");

// ── Data platform (after 20261115) ──────────────────────────────────────────
await check("platform", "Archived flights with no past_flights record", "high",
  S(`SELECT fi.id FROM flight_intents fi WHERE fi.status = 'archived' AND NOT EXISTS (SELECT 1 FROM past_flights p WHERE p.flight_intent_id = fi.id)`), "");
await check("platform", "Verified past flights with <10 GPS fixes", "high",
  S(`SELECT id FROM past_flights WHERE verification_status = 'verified' AND telemetry_points < 10`), "");
await check("platform", "Stale data sources", "high",
  S(`SELECT id FROM data_source_status WHERE freshness IN ('stale','never') AND enabled AND cadence_seconds IS NOT NULL`), "");
await check("platform", "More than one active model per kind", "critical",
  S(`SELECT kind AS id FROM model_params WHERE status='active' GROUP BY kind HAVING count(*) > 1`), "");

await check("platform", "Corrections recorded (originals preserved)", "info",
  S(`SELECT id::text FROM record_corrections`), "Evidence-based fixes; see record_corrections for original values.");

// ── Inventory ───────────────────────────────────────────────────────────────
const inventory = [];
for (const t of ["flight_intents", "routes", "flight_decisions", "flight_outcomes", "historical_flights", "route_patterns",
  "route_score_config", "user_error_profiles", "time_slots", "vertiport_slots", "vertiports", "past_flights",
  "wx_metar", "wx_advisories", "airspace_restrictions", "traffic_observations", "wx_verification", "model_params", "record_corrections"]) {
  try { inventory.push([t, (await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n]); }
  catch { inventory.push([t, "n/a"]); }
}
try {
  const st = (await db.query(`SELECT status, count(*)::int n FROM flight_intents GROUP BY 1 ORDER BY 2 DESC`)).rows;
  inventory.push(["flight_intents by status", st.map((r) => `${r.status}=${r.n}`).join(", ")]);
} catch { /* ignore */ }

if (exportDir) {
  mkdirSync(exportDir, { recursive: true });
  for (const [t, n] of inventory) {
    if (typeof n !== "number") continue;
    const rows = (await db.query(`SELECT * FROM ${t}`)).rows;
    writeFileSync(join(exportDir, `${t}.json`), JSON.stringify(rows));
  }
  console.error(`exported ${inventory.filter(([, n]) => typeof n === "number").length} tables to ${exportDir}`);
}
await db.end();

// ── Report ──────────────────────────────────────────────────────────────────
const order = { critical: 0, high: 1, medium: 2, info: 3 };
const issues = findings.filter((f) => f.status === "issue").sort((a, b) => order[a.severity] - order[b.severity]);
const lines = [
  `# SHNAV data audit — ${new Date().toISOString()}`, "",
  `Read-only. ${issues.length} issue(s) found across ${findings.filter((f) => f.status !== "n/a").length} applicable checks.`, "",
  "## Issues", "",
  ...(issues.length ? issues.map((f) => `- **${f.severity.toUpperCase()}** [${f.area}] ${f.title}: **${f.n}**${f.explain ? ` — ${f.explain}` : ""}${f.sample ? `\n  - sample: \`${JSON.stringify(f.sample)}\`` : ""}`) : ["None."]),
  "", "## Passing checks", "",
  ...findings.filter((f) => f.status === "ok").map((f) => `- [${f.area}] ${f.title}`),
  "", "## Not applicable to this schema", "",
  ...findings.filter((f) => f.status === "n/a").map((f) => `- [${f.area}] ${f.title} (${f.error})`),
  "", "## Inventory", "", "| table | rows |", "|---|---|",
  ...inventory.map(([t, n]) => `| ${t} | ${n} |`), "",
];
const report = lines.join("\n");
if (outFile) writeFileSync(outFile, report);
console.log(report);
process.exit(issues.some((f) => f.severity === "critical") ? 1 : 0);
