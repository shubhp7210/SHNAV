// Data-platform tests (20261115000000_data_platform.sql) against a real Postgres.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node --test supabase/tests/data_platform.test.mjs
//
// Legacy rows are inserted BEFORE the data-platform migration runs, so the
// backfill path is exercised exactly as it will run on production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("DATABASE_URL is required");

const dbName = `shnav_dp_${Date.now()}`;
const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`; return u.toString(); })();
const DP = "20261115000000_data_platform.sql";
const migrations = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const sqlFile = (...p) => readFileSync(join(root, ...p), "utf8");

let db;
const conn = async () => { const c = new pg.Client({ connectionString: dbUrl }); await c.connect(); return c; };
const q = (text, params) => db.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
// Downtown Manhattan Heliport → LaGuardia
const O = { lat: 40.7012, lon: -74.0091 };
const D = { lat: 40.7769, lon: -73.874 };
let legacyLanded, legacyExpired, legacyOrphan;

async function intent(over = {}) {
  const r = await q(
    `INSERT INTO flight_intents (user_id, aircraft_id, operator_name, origin, destination, altitude_band,
       departure_window_start, departure_window_end, status, departure_start_at, departure_end_at,
       origin_lat, origin_lon, dest_lat, dest_lon, coords_status, created_at)
     VALUES ($1,$2,'Test Ops','Downtown Manhattan Heliport @ 40.7012,-74.0091','LaGuardia @ 40.7769,-73.8740',$3,
       '10:00','10:10',$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now())) RETURNING id`,
    [over.user ?? USER, over.aircraft ?? `N${Math.floor(Math.random() * 1e6)}`, over.band ?? "low",
     over.status ?? "pending", over.start ?? new Date(Date.now() - 3600e3).toISOString(),
     over.end ?? new Date(Date.now() - 3000e3).toISOString(),
     O.lat, O.lon, D.lat, D.lon, over.coords ?? "resolved", over.created ?? new Date(Date.now() - 7200e3).toISOString()],
  );
  return r.rows[0].id;
}

async function routeFor(id, estMin = 9.8) {
  const wps = [{ lat: O.lat, lon: O.lon }, { lat: D.lat, lon: D.lon }];
  await q(`INSERT INTO routes (flight_intent_id, aircraft_id, operator_name, origin, destination, altitude_band,
             overall_score, safety_score, weather_score, traffic_score, efficiency_score, weather_risk, weather_conditions, primary_route)
           VALUES ($1,'AC','Ops','o','d','low',80,80,80,80,80,'low',$2,$3)`,
    [id, JSON.stringify({ wind_speed: 30, wind_gusts: 40, valid_at: "2026-01-01T00:00:00Z" }),
     JSON.stringify({ id: "direct", waypoints: wps, estimated_time_min: estMin, raw_estimated_time_min: estMin })]);
}

/** n fixes along O→D ending at D, starting `t0` and spaced `stepS` seconds. */
function track(t0, n = 15, stepS = 45) {
  return Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1);
    return { t: new Date(t0 + i * stepS * 1000).toISOString(), lat: O.lat + (D.lat - O.lat) * f, lon: O.lon + (D.lon - O.lon) * f, acc: 8 };
  });
}

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = await conn();
  await q(sqlFile("tests", "bootstrap.sql"));
  for (const f of migrations.filter((m) => m !== DP)) await q(sqlFile("migrations", f));
  await q(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@test'), ($2, 'b@test')`, [USER, OTHER]);
  // ── Legacy state as it exists in production before the rebuild ──
  legacyLanded = await intent({ status: "pending" });
  await q(`UPDATE flight_intents SET status='landed' WHERE id=$1`, [legacyLanded]); // old trigger → archived + historical copy
  legacyExpired = await intent({ status: "expired" });
  legacyOrphan = "33333333-3333-3333-3333-333333333333";
  await q(`INSERT INTO historical_flights (flight_intent_id, user_id, aircraft_id, operator_name, origin, destination, trajectory_score)
           VALUES ($1,$2,'OLD1','Ops','A','B',150)`, [legacyOrphan, USER]);
  await q(`INSERT INTO route_patterns (origin_key, destination_key, altitude_band, user_id, flight_count, avg_overall_score,
             completed_flight_count, outcome_adjusted_score, systematic_error)
           VALUES ('legacy o','legacy d','low',NULL,5,70,5,95,25)`);
  await q(`INSERT INTO user_error_profiles (user_id, total_flights, total_anomalies, confidence_adjustment) VALUES ($1, 4, 9, -20)`, [USER]);
  await q(`INSERT INTO flight_outcomes (flight_intent_id, aircraft_id, actual_duration_minutes, experienced_max_wind_kmh, experienced_max_gusts_kmh, experienced_route_deviation_m)
           VALUES ($1, 'L1', 12, 0, 0, 0)`, [legacyLanded]);
  await q(`INSERT INTO routes (flight_intent_id, aircraft_id, operator_name, origin, destination, altitude_band, overall_score, safety_score,
             weather_score, traffic_score, efficiency_score, primary_route, weather_conditions)
           VALUES ($1,'L1','o','a','b','low',104,90,90,90,118,'{}', '{"wind_speed":0,"wind_gusts":0}')`, [legacyLanded]);
  await q(`UPDATE route_score_config SET weight_safety = 0.41, total_outcomes_seen = 9`);
  // ── Apply the data-platform migration ──
  await q(sqlFile("migrations", DP));
});

after(async () => {
  await db?.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

// ─── Rebuild / backfill ─────────────────────────────────────────────────────
test("migration archives contaminated learned state before resetting it", async () => {
  const arch = await one(`SELECT outcome_adjusted_score::int s, systematic_error::int e FROM archive_20261115.route_patterns WHERE origin_key='legacy o'`);
  assert.deepEqual(arch, { s: 95, e: 25 });
  const live = await one(`SELECT outcome_adjusted_score s, systematic_error::int e, completed_flight_count c FROM route_patterns WHERE origin_key='legacy o'`);
  assert.deepEqual(live, { s: null, e: 0, c: 0 });
  assert.equal((await one(`SELECT count(*)::int n FROM archive_20261115.user_error_profiles`)).n, 1);
  assert.equal((await one(`SELECT count(*)::int n FROM user_error_profiles`)).n, 0);
});

test("legacy values without a measurement or outside their defined range are corrected, originals logged", async () => {
  const o = await one(`SELECT id, experienced_max_wind_kmh w, experienced_route_deviation_m d FROM flight_outcomes WHERE flight_intent_id=$1`, [legacyLanded]);
  assert.deepEqual({ w: o.w, d: o.d }, { w: null, d: null });
  const rt = await one(`SELECT id, overall_score::int o, efficiency_score::int e, weather_conditions wc FROM routes WHERE flight_intent_id=$1`, [legacyLanded]);
  assert.deepEqual({ o: rt.o, e: rt.e, wc: rt.wc }, { o: 100, e: 100, wc: null });
  const logged = (await q(`SELECT table_name, field, original_value FROM record_corrections WHERE record_id = ANY($1::uuid[]) ORDER BY 1, 2`,
    [[o.id, rt.id]])).rows.map((r) => `${r.table_name}.${r.field}=${JSON.stringify(r.original_value)}`);
  assert.ok(logged.includes("flight_outcomes.experienced_max_wind_kmh=0"), logged.join(" "));
  assert.ok(logged.includes("routes.overall_score=104"));
  assert.ok(logged.includes('routes.weather_conditions={"wind_gusts":0,"wind_speed":0}'));
  assert.equal(Number((await one(`SELECT weight_safety FROM route_score_config LIMIT 1`)).weight_safety), 0.35);
  assert.equal(Number((await one(`SELECT weight_safety FROM archive_20261115.route_score_config LIMIT 1`)).weight_safety), 0.41);
});

test("every ended legacy flight is preserved in past_flights as unverified and excluded from learning", async () => {
  const rows = (await q(`SELECT flight_intent_id::text id, final_status, verification_status, learning_excluded
                         FROM past_flights WHERE flight_intent_id = ANY($1::uuid[]) ORDER BY 1`,
                        [[legacyLanded, legacyExpired, legacyOrphan]])).rows;
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.final_status, "legacy");
    assert.equal(r.verification_status, "legacy_unverified");
    assert.equal(r.learning_excluded, true);
  }
  assert.equal((await one(`SELECT status FROM flight_intents WHERE id=$1`, [legacyExpired])).status, "archived");
  // Legacy rows can never reach training.
  assert.equal((await one(`SELECT count(*)::int n FROM training_flights(now() + interval '1 day')`)).n, 0);
});

// ─── Ingestion control ──────────────────────────────────────────────────────
test("concurrent ingest claims: exactly one worker gets the lease", async () => {
  const clients = await Promise.all(Array.from({ length: 10 }, conn));
  const res = await Promise.all(clients.map((c) => c.query(`SELECT ingest_claim('awc-metar') r`)));
  await Promise.all(clients.map((c) => c.end()));
  const won = res.map((r) => r.rows[0].r).filter(Boolean);
  assert.equal(won.length, 1);
  assert.equal((await one(`SELECT count(*)::int n FROM ingest_runs WHERE source_id='awc-metar'`)).n, 1);
  await q(`SELECT ingest_finish($1, 'ok', 200, 5, 5, 0, 0)`, [won[0].run_id]);
  // Not due again until its cadence elapses (unless forced).
  assert.equal((await one(`SELECT ingest_claim('awc-metar') r`)).r, null);
  const forced = (await one(`SELECT ingest_claim('awc-metar', true) r`)).r;
  assert.ok(forced?.run_id);
  await q(`SELECT ingest_finish($1, 'not_modified', 304)`, [forced.run_id]);
});

test("failures back off exponentially, honour Retry-After and alert after 3 in a row", async () => {
  const fail = async (retry = null) => {
    const r = (await one(`SELECT ingest_claim('nws-alerts', true) r`)).r;
    await q(`SELECT ingest_finish($1, 'error', 503, 0,0,0,0, 'upstream 503', NULL, NULL, $2)`, [r.run_id, retry]);
    return one(`SELECT consecutive_failures n, extract(epoch FROM backoff_until - now())::int s FROM data_sources WHERE id='nws-alerts'`);
  };
  const a = await fail(); const b = await fail(); const c = await fail(120);
  assert.equal(a.n, 1); assert.ok(a.s >= 595 && a.s <= 600, `1st backoff ${a.s}`);
  assert.equal(b.n, 2); assert.ok(b.s >= 1195 && b.s <= 1200, `2nd backoff ${b.s}`);
  assert.equal(c.n, 3); assert.ok(c.s >= 115 && c.s <= 120, `Retry-After backoff ${c.s}`);
  assert.equal((await one(`SELECT count(*)::int n FROM alert_events WHERE kind='source_failing'`)).n, 1);
  // Backed-off sources are not due; a success resets the counter.
  assert.ok(!(await q(`SELECT s FROM ingest_due_sources() s`)).rows.some((r) => r.s === "nws-alerts"));
  const r = (await one(`SELECT ingest_claim('nws-alerts', true) r`)).r;
  await q(`SELECT ingest_finish($1, 'ok', 200)`, [r.run_id]);
  assert.equal((await one(`SELECT consecutive_failures n FROM data_sources WHERE id='nws-alerts'`)).n, 0);
});

test("ADS-B traffic is only fetched while flights are operating", async () => {
  await q(`UPDATE data_sources SET next_run_at = NULL, backoff_until = NULL, lease_until = NULL WHERE id='opensky'`);
  const due = async () => (await q(`SELECT s FROM ingest_due_sources() s`)).rows.map((r) => r.s);
  await q(`UPDATE flight_intents SET status='archived' WHERE status IN ('in_air','active','pending','approved')`);
  assert.ok(!(await due()).includes("opensky"));
  const id = await intent({ status: "in_air" });
  assert.ok((await due()).includes("opensky"));
  await q(`UPDATE flight_intents SET status='archived' WHERE id=$1`, [id]);
});

test("observations are deduplicated by content and readable (not writable) by signed-in users", async () => {
  const ins = `INSERT INTO wx_metar (station, obs_time, lat, lon, wind_kt, raw, source_id, content_hash)
               VALUES ('KTST', '2026-11-15T12:00:00Z', 40.7, -74.0, 10, 'METAR KTST', 'awc-metar', 'h1') ON CONFLICT DO NOTHING`;
  await q(ins); await q(ins);
  assert.equal((await one(`SELECT count(*)::int n FROM wx_metar WHERE station='KTST'`)).n, 1);
  const c = await conn();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER]);
    assert.equal((await c.query(`SELECT count(*)::int n FROM wx_metar WHERE station='KTST'`)).rows[0].n, 1);
    assert.ok((await c.query(`SELECT count(*)::int n FROM data_source_status`)).rows[0].n >= 8);
    await assert.rejects(c.query(`INSERT INTO wx_metar (station, obs_time, lat, lon, raw, source_id, content_hash) VALUES ('X', now(), 0, 0, 'x', 'awc-metar', 'z')`), /permission denied/);
  } finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
  await q(`DELETE FROM wx_metar WHERE station='KTST'`);
});

test("nearest_metar never looks ahead and never returns a stale observation as current", async () => {
  const at = new Date("2026-11-15T15:00:00Z");
  for (const [mins, wind] of [[-50, 5], [-120, 7], [+20, 30]]) {
    await q(`INSERT INTO wx_metar (station, obs_time, lat, lon, wind_kt, raw, source_id, content_hash)
             VALUES ('KNYC', $1, 40.779, -73.969, $2, 'METAR KNYC', 'awc-metar', $3)`,
      [new Date(at.getTime() + mins * 60e3).toISOString(), wind, `n${mins}`]);
  }
  const r = await one(`SELECT station, wind_kt::int w, round(age_minutes)::int age FROM nearest_metar(40.75, -73.98, $1)`, [at.toISOString()]);
  assert.deepEqual(r, { station: "KNYC", w: 5, age: 50 });   // not the +20 min (future) one, not the 120-min-old one
  const none = await q(`SELECT * FROM nearest_metar(40.75, -73.98, $1, 30, interval '30 minutes')`, [at.toISOString()]);
  assert.equal(none.rowCount, 0);
  await q(`DELETE FROM wx_metar WHERE station='KNYC'`);
});

// ─── Telemetry ──────────────────────────────────────────────────────────────
test("telemetry: owner + airborne only; implausible, future and duplicate fixes are rejected", async () => {
  const id = await intent({ status: "pending" });
  const pts = track(Date.now() - 600e3, 5, 30);
  assert.equal((await one(`SELECT ingest_telemetry($1,$2,$3::jsonb) r`, [USER, id, JSON.stringify(pts)])).r.error, "not_airborne");
  await q(`UPDATE flight_intents SET status='in_air' WHERE id=$1`, [id]);
  assert.equal((await one(`SELECT ingest_telemetry($1,$2,$3::jsonb) r`, [OTHER, id, JSON.stringify(pts)])).r.error, "not_found");
  const bad = [
    ...pts,
    { t: new Date(Date.now() - 400e3).toISOString(), lat: 41.5, lon: -73.0, acc: 5 },   // 100+ km jump in seconds
    { t: new Date(Date.now() + 3600e3).toISOString(), lat: O.lat, lon: O.lon },        // future
    { t: "not-a-time", lat: 1, lon: 1 },
  ];
  const r = (await one(`SELECT ingest_telemetry($1,$2,$3::jsonb) r`, [USER, id, JSON.stringify(bad)])).r;
  assert.equal(r.inserted, 5);
  assert.equal(r.rejected, 3);
  const again = (await one(`SELECT ingest_telemetry($1,$2,$3::jsonb) r`, [USER, id, JSON.stringify(pts)])).r;
  assert.equal(again.duplicates, 5);
  const fi = await one(`SELECT telemetry_source, telemetry_count FROM flight_intents WHERE id=$1`, [id]);
  assert.deepEqual(fi, { telemetry_source: "gps", telemetry_count: 5 });
});

// ─── Active → Past ──────────────────────────────────────────────────────────
async function flownGpsFlight({ estMin = 9.8, depOffsetMin = 70, user = USER, landedAgoMin = 3 } = {}) {
  const t0 = Date.now() - depOffsetMin * 60e3;
  const id = await intent({ status: "pending", user, start: new Date(t0 - 15 * 60e3).toISOString(), end: new Date(t0 - 5 * 60e3).toISOString() });
  await routeFor(id, estMin);
  await q(`UPDATE flight_intents SET status='in_air' WHERE id=$1`, [id]);
  await q(`SELECT ingest_telemetry($1,$2,$3::jsonb)`, [user, id, JSON.stringify(track(t0, 15, 45))]);
  await q(`SELECT record_flight_outcome_tx($1,$2,$3::jsonb)`, [user, id, JSON.stringify({ aircraft_id: "N1", actual_duration_minutes: 30 })]);
  await q(`UPDATE flight_intents SET landed_at = now() - make_interval(mins => $2) WHERE id=$1`, [id, landedAgoMin]);
  return { id, t0 };
}

test("a GPS-tracked flight is moved to past_flights only after its end is confirmed, as verified", async () => {
  const { id } = await flownGpsFlight({ landedAgoMin: 0 });
  await q(`SELECT finalize_ended_flights()`);
  // Landing just reported — GPS tail may still arrive: not finalized yet.
  assert.equal((await one(`SELECT status FROM flight_intents WHERE id=$1`, [id])).status, "landed");
  await q(`UPDATE flight_intents SET landed_at = now() - interval '3 minutes' WHERE id=$1`, [id]);
  await q(`SELECT finalize_ended_flights()`);
  const pf = await one(`SELECT final_status, verification_status, telemetry_points, round(actual_duration_min)::int dur,
                          max_deviation_m < 50 on_track, planned_duration_min::float planned, prediction_snapshot->>'decision' d,
                          (outcome_reported->>'actual_duration_minutes')::int reported
                        FROM past_flights WHERE flight_intent_id=$1`, [id]);
  assert.equal(pf.final_status, "completed");
  assert.equal(pf.verification_status, "verified");
  assert.equal(pf.telemetry_points, 15);
  assert.ok(pf.dur >= 9 && pf.dur <= 11, `duration ${pf.dur}`);   // first fix >300 m from origin → first fix ≤400 m of destination
  assert.equal(pf.on_track, true);
  assert.equal(pf.planned, 9.8);
  assert.equal(pf.reported, 30);                                    // client report kept verbatim…
  assert.equal((await one(`SELECT status FROM flight_intents WHERE id=$1`, [id])).status, "archived");
});

test("simulated, never-departed and silent flights are classified honestly", async () => {
  const sim = await intent({ status: "pending" });
  await q(`UPDATE flight_intents SET status='in_air' WHERE id=$1`, [sim]);
  await q(`UPDATE flight_intents SET status='landed', landed_at = now() - interval '5 minutes' WHERE id=$1`, [sim]);
  const never = await intent({ status: "expired" });
  const silent = await intent({ status: "in_air", end: new Date(Date.now() - 3 * 3600e3).toISOString(), start: new Date(Date.now() - 4 * 3600e3).toISOString() });
  await q(`UPDATE flight_intents SET in_air_at = now() - interval '3 hours' WHERE id=$1`, [silent]);
  await q(`SELECT finalize_ended_flights()`);
  const get = (id) => one(`SELECT final_status f, verification_status v, weather_obs_status w FROM past_flights WHERE flight_intent_id=$1`, [id]);
  assert.deepEqual(await get(sim), { f: "simulated", v: "simulated", w: "not_applicable" });
  assert.deepEqual(await get(never), { f: "not_flown", v: "unverified", w: "not_applicable" });
  assert.deepEqual(await get(silent), { f: "ended_unconfirmed", v: "unverified", w: "pending" });
});

test("concurrent finalizers produce exactly one past record", async () => {
  const { id } = await flownGpsFlight();
  const clients = await Promise.all(Array.from({ length: 6 }, conn));
  await Promise.all(clients.map((c) => c.query(`SELECT finalize_flight($1)`, [id])));
  await Promise.all(clients.map((c) => c.end()));
  assert.equal((await one(`SELECT count(*)::int n FROM past_flights WHERE flight_intent_id=$1`, [id])).n, 1);
});

test("past flights are append-only; corrections keep the original value and evidence", async () => {
  const { id } = await flownGpsFlight();
  await q(`SELECT finalize_flight($1)`, [id]);
  const pf = await one(`SELECT id, actual_duration_min::float d FROM past_flights WHERE flight_intent_id=$1`, [id]);
  await assert.rejects(q(`UPDATE past_flights SET actual_duration_min = 1 WHERE id=$1`, [pf.id]), /apply_correction/);
  await assert.rejects(q(`DELETE FROM past_flights WHERE id=$1`, [pf.id]), /permanent/);
  await q(`UPDATE past_flights SET analysis = '{"note":1}' WHERE id=$1`, [pf.id]);   // enrichment is allowed
  await assert.rejects(q(`SELECT apply_correction('past_flights', $1, 'user_id', '"x"', 'r', '{"e":1}', 't')`, [pf.id]), /not correctable/);
  await assert.rejects(q(`SELECT apply_correction('past_flights', $1, 'actual_duration_min', '12', 'r', '{}', 't')`, [pf.id]), /evidence/);
  await q(`SELECT apply_correction('past_flights', $1, 'actual_duration_min', '12.5', 'test', '{"why":"test"}', 'tester')`, [pf.id]);
  const c = await one(`SELECT original_value::float o, corrected_value::float n, actor FROM record_corrections WHERE record_id=$1`, [pf.id]);
  assert.deepEqual(c, { o: pf.d, n: 12.5, actor: "tester" });
  assert.equal((await one(`SELECT actual_duration_min::float d FROM past_flights WHERE id=$1`, [pf.id])).d, 12.5);
});

// ─── Leakage guard ──────────────────────────────────────────────────────────
test("planning role (service_role) cannot read outcome history; users see only their own past flights", async () => {
  const c = await conn();
  try {
    for (const t of ["past_flights", "prediction_errors", "wx_verification", "record_corrections"]) {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
      await assert.rejects(c.query(`SELECT 1 FROM ${t} LIMIT 1`), /permission denied/, t);
      await c.query("ROLLBACK");
    }
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    await assert.rejects(c.query(`SELECT * FROM training_flights(now())`), /permission denied/);
    await c.query("ROLLBACK");
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    const p = (await c.query(`SELECT active_model_params() p`)).rows[0].p;
    assert.deepEqual(Object.keys(p).sort(), ["duration_calibration", "route_stats", "route_weights", "wind_bias"]);
    await c.query("ROLLBACK");
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [OTHER]);
    const mine = (await c.query(`SELECT count(*)::int n FROM past_flights WHERE user_id <> $1`, [OTHER])).rows[0].n;
    assert.equal(mine, 0);
    await c.query("ROLLBACK");
  } finally { await c.end(); }
});

// ─── Reconciliation + self-correction ───────────────────────────────────────
test("reconcile pairs flights with observed weather, records prediction errors and corrects the bad client report", async () => {
  const { id, t0 } = await flownGpsFlight();
  await q(`SELECT finalize_flight($1)`, [id]);
  const pf = await one(`SELECT id, actual_departure_at FROM past_flights WHERE flight_intent_id=$1`, [id]);
  // METAR at the Battery-ish point near origin 5 min after departure: 10 kt, gust 20 kt.
  await q(`INSERT INTO wx_metar (station, obs_time, lat, lon, wind_kt, gust_kt, visibility_sm, raw, source_id, content_hash)
           VALUES ('KJRB', $1, 40.70, -74.01, 10, 20, 10, 'METAR KJRB', 'awc-metar', $2)`,
    [new Date(new Date(pf.actual_departure_at).getTime() + 5 * 60e3).toISOString(), `r${t0}`]);
  const r = (await one(`SELECT reconcile_past_flight($1) r`, [pf.id])).r;
  assert.equal(r.weather_obs_status, "observed");
  const errs = Object.fromEntries((await q(`SELECT kind, error::float e, verified FROM prediction_errors WHERE past_flight_id=$1`, [pf.id])).rows.map((x) => [x.kind, x]));
  assert.ok(errs.duration && errs.duration.verified);
  assert.ok(Math.abs(errs.wind.e - (30 - 18.5)) < 0.2, `wind error ${errs.wind.e}`);     // forecast 30 km/h vs 10 kt
  assert.ok(Math.abs(errs.gust.e - (40 - 37)) < 0.2, `gust error ${errs.gust.e}`);
  // The landing report claimed 30 min; GPS says ~10 → corrected with the original preserved.
  const corr = await one(`SELECT original_value::float o, corrected_value::float n, reason FROM record_corrections
                          WHERE table_name='flight_outcomes' AND field='actual_duration_minutes'
                            AND record_id = (SELECT id FROM flight_outcomes WHERE flight_intent_id=$1)`, [id]);
  assert.equal(corr.o, 30);
  assert.ok(corr.n > 8 && corr.n < 12);
  assert.match(corr.reason, /GPS/);
});

// ─── Training ───────────────────────────────────────────────────────────────
async function verifiedPast({ planned, actual, arrival, availableAt, band = "low" }) {
  const fid = (await one(`SELECT gen_random_uuid() id`)).id;
  await q(`INSERT INTO past_flights (flight_intent_id, user_id, aircraft_id, origin, destination, altitude_band,
             final_status, verification_status, telemetry_source, telemetry_points, actual_departure_at, actual_arrival_at,
             actual_duration_min, planned_duration_min, prediction_snapshot, weather_obs_status, archived_at, available_at)
           VALUES ($1,$2,'T','Pier A','JFK',$3,'completed','verified','gps',20, $4::timestamptz - make_interval(mins => $5::int), $4,
             $5,$6, jsonb_build_object('raw_estimated_time_min', $6::numeric), 'observed', $7, $7)`,
    [fid, USER, band, arrival, actual, planned, availableAt ?? arrival]);
}

test("duration calibration learns only from data known at the as-of time and must beat the active model on a holdout", async () => {
  await q(`UPDATE past_flights SET learning_excluded = true WHERE verification_status = 'verified'`);   // isolate from earlier tests
  const base = Date.parse("2026-06-01T12:00:00Z");
  for (let i = 0; i < 14; i++) {
    await verifiedPast({ planned: 10, actual: 12, arrival: new Date(base + i * 86400e3).toISOString() });
  }
  // Flights that happen AFTER the as-of time — must be invisible to training.
  for (let i = 0; i < 6; i++) {
    await verifiedPast({ planned: 10, actual: 30, arrival: new Date(base + (40 + i) * 86400e3).toISOString() });
  }
  const asOf = new Date(base + 20 * 86400e3).toISOString();
  assert.equal((await one(`SELECT count(*)::int n FROM training_flights($1)`, [asOf])).n, 14);
  const r = (await one(`SELECT train_duration_calibration($1) r`, [asOf])).r;
  assert.equal(r.status, "active", JSON.stringify(r));
  const p = (await one(`SELECT params FROM model_params WHERE kind='duration_calibration' AND status='active'`)).params;
  assert.equal(Number(p.factor_by_band.low), 1.2);              // not polluted by the later 3× flights
  // Re-training on the same data cannot beat itself → rejected, active unchanged.
  const again = (await one(`SELECT train_duration_calibration($1) r`, [asOf])).r;
  assert.equal(again.status, "rejected");
  assert.equal((await one(`SELECT count(*)::int n FROM model_params WHERE kind='duration_calibration' AND status='active'`)).n, 1);
  // Too little data → nothing trained.
  const early = (await one(`SELECT train_duration_calibration($1) r`, [new Date(base + 3 * 86400e3).toISOString()])).r;
  assert.equal(early.status, "insufficient_data");
});

test("forecast verification pairs Open-Meteo snapshots with METARs and learns the wind bias", async () => {
  // Pairs become known when paired (now), so the window must end now.
  const base = Date.now() - 5 * 86400e3;
  for (let i = 0; i < 60; i++) {
    const t = new Date(base + i * 3600e3).toISOString();
    await q(`INSERT INTO wx_metar (station, obs_time, lat, lon, wind_kt, raw, source_id, content_hash)
             VALUES ('KLGA', $1::timestamptz + interval '3 minutes', 40.7769, -73.874, 10, 'METAR KLGA', 'awc-metar', $2)`, [t, `v${i}`]);
    await q(`INSERT INTO wx_forecast_snapshots (source_id, purpose, station, lat, lon, valid_at, fetched_at, lead_minutes, wind_kmh, gust_kmh, content_hash)
             VALUES ('open-meteo-verif','verification','KLGA',40.7769,-73.874,$1, $1::timestamptz - interval '1 hour', 60, $2, $2, $3)`,
      [t, 18.52 + 8 + (i % 3) - 1, `s${i}`]);
  }
  assert.equal((await one(`SELECT pair_forecast_verification() n`)).n, 60);
  assert.equal((await one(`SELECT pair_forecast_verification() n`)).n, 0);   // idempotent
  // As of a time before the pairs existed, nothing is learnable (no look-back leakage).
  const before = (await one(`SELECT train_wind_bias($1) r`, [new Date(base + 70 * 3600e3).toISOString()])).r;
  assert.equal(before.status, "insufficient_data");
  const r = (await one(`SELECT train_wind_bias(now()) r`)).r;
  assert.equal(r.status, "active", JSON.stringify(r));
  const p = (await one(`SELECT params FROM model_params WHERE kind='wind_bias' AND status='active'`)).params;
  assert.ok(Math.abs(Number(p.wind_bias_kmh) - 8) < 0.6, `bias ${p.wind_bias_kmh}`);
});

// ─── User error patterns ────────────────────────────────────────────────────
test("repeated late departures raise an explained, unconfirmed flag the owner can confirm or dismiss", async () => {
  const U3 = "44444444-4444-4444-4444-444444444444";
  await q(`INSERT INTO auth.users (id, email) VALUES ($1, 'c@test')`, [U3]);
  for (let i = 0; i < 6; i++) {
    const end = Date.parse("2026-09-01T12:00:00Z") + i * 86400e3;
    await q(`INSERT INTO past_flights (flight_intent_id, user_id, aircraft_id, origin, destination, final_status, verification_status,
               telemetry_source, telemetry_points, planned_departure_start, planned_departure_end, actual_departure_at, weather_obs_status)
             VALUES (gen_random_uuid(), $1, 'P', 'a', 'b', 'completed', 'verified', 'gps', 20, $2::timestamptz - interval '10 minutes', $2,
                     $2::timestamptz + make_interval(mins => $3::int), 'observed')`, [U3, new Date(end).toISOString(), i < 5 ? 25 : 0]);
  }
  await q(`SELECT detect_user_patterns()`);
  const f = await one(`SELECT id, status, summary, jsonb_array_length(evidence->'flights') n FROM user_pattern_flags WHERE user_id=$1 AND pattern='late_departure'`, [U3]);
  assert.equal(f.status, "suspected");                 // never assumed
  assert.equal(f.n, 5);
  assert.match(f.summary, /5 of your last 6/);
  const respond = async (sub, resp) => {
    const c = await conn();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
      await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
      const r = (await c.query(`SELECT respond_pattern_flag($1, $2) r`, [f.id, resp])).rows[0].r;
      await c.query("COMMIT"); return r;
    } finally { await c.end(); }
  };
  assert.equal((await respond(OTHER, "confirm")).error, "not_found");
  assert.equal((await respond(U3, "dismiss")).status, "dismissed");
  // A dismissal is respected: re-running detection does not re-raise it.
  await q(`SELECT detect_user_patterns()`);
  assert.equal((await one(`SELECT count(*)::int n FROM user_pattern_flags WHERE user_id=$1 AND status IN ('suspected','confirmed')`, [U3])).n, 0);
});

// ─── Integrity ──────────────────────────────────────────────────────────────
test("integrity checks catch an archived flight with no past record and raise an alert", async () => {
  const id = await intent({ status: "pending" });
  await q(`UPDATE flight_intents SET status='archived' WHERE id=$1`, [id]);
  const r = (await one(`SELECT run_integrity_checks() r`)).r;
  assert.equal(r.archived_without_past_record.status, "fail");
  assert.equal(r.multiple_active_models.status, "pass");
  assert.equal(r.verified_without_telemetry.status, "pass");
  assert.ok((await one(`SELECT count(*)::int n FROM alert_events WHERE kind='integrity' AND message LIKE '%archived_without_past_record%'`)).n === 1);
  // The finalizer repairs it on its next run.
  await q(`SELECT finalize_ended_flights()`);
  assert.equal((await one(`SELECT run_integrity_checks() r`)).r.archived_without_past_record.status, "pass");
});

test("full learning cycle runs end-to-end without errors", async () => {
  const r = (await one(`SELECT run_learning_cycle() r`)).r;
  for (const k of ["reconcile", "duration_calibration", "wind_bias", "route_stats", "user_patterns"]) assert.ok(k in r, k);
});
