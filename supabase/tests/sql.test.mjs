// Database tests: apply EVERY migration to a real Postgres, then exercise the
// production-readiness functions — including true concurrency (separate
// connections racing) and the rollback script.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node --test supabase/tests/sql.test.mjs
//
// A fresh database is created per run and dropped afterwards.
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

const dbName = `shnav_test_${Date.now()}`;
const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`; return u.toString(); })();
const migrations = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const sqlFile = (...p) => readFileSync(join(root, ...p), "utf8");

let db; // main connection (superuser)
const conn = async () => { const c = new pg.Client({ connectionString: dbUrl }); await c.connect(); return c; };
const q = (text, params) => db.query(text, params);

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

async function applyMigrations(client) {
  for (const f of migrations) {
    try { await client.query(sqlFile("migrations", f)); }
    catch (e) { throw new Error(`migration ${f} failed: ${e.message}`); }
  }
}

async function intent(over = {}) {
  const r = await q(
    `INSERT INTO flight_intents (user_id, aircraft_id, operator_name, origin, destination, altitude_band,
       departure_window_start, departure_window_end, status, departure_start_at, departure_end_at)
     VALUES ($1, $2, 'Test Ops', $3, $4, $5, '10:00', '10:10', $6, $7, $8) RETURNING id`,
    [over.user ?? USER, over.aircraft ?? `N${Math.floor(Math.random() * 1e6)}`,
     over.origin ?? "Downtown Manhattan Heliport @ 40.7012,-74.0091",
     over.destination ?? "LaGuardia @ 40.7769,-73.8740",
     over.band ?? "high", over.status ?? "pending",
     over.start ?? "2030-01-01T15:00:00Z", over.end ?? "2030-01-01T15:10:00Z"],
  );
  return r.rows[0].id;
}

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  db = await conn();
  await db.query(sqlFile("tests", "bootstrap.sql"));
  await applyMigrations(db);
  await q(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@test'), ($2, 'b@test')`, [USER, OTHER]);
});

after(async () => {
  await db?.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

test("all migrations applied; real vertiports active, fictional ones inactive", async () => {
  const active = (await q(`SELECT faa_id FROM vertiports WHERE is_active ORDER BY faa_id`)).rows.map((r) => r.faa_id);
  assert.deepEqual(active, ["6N5", "EWR", "JFK", "JRA", "JRB", "LGA"]);
  const fake = (await q(`SELECT count(*)::int n FROM vertiports WHERE name = 'Airport Vertiport North' AND is_active`)).rows[0].n;
  assert.equal(fake, 0);
});

test("concurrent airspace reservations never exceed capacity", async () => {
  // 'high' band has exactly one open segment (North Corridor high, 6/hour).
  const cap = (await q(`SELECT sum(capacity_per_hour)::int c FROM airspace_segments WHERE altitude_band='high' AND NOT is_no_fly`)).rows[0].c;
  assert.equal(cap, 6);
  const ids = [];
  for (let i = 0; i < 15; i++) ids.push(await intent({ band: "high" }));
  const clients = await Promise.all(ids.map(() => conn()));
  const results = await Promise.all(ids.map((id, i) => clients[i].query(
    `SELECT reserve_airspace_slot($1, 'AC', 'high', '2030-01-01T15:00:00Z', 60, false) r`, [id])));
  await Promise.all(clients.map((c) => c.end()));
  const delays = results.map((r) => r.rows[0].r.delay_minutes).sort((a, b) => a - b);
  // 6 fit at +0; the 7th finds +15 (window shifted half out of the first six) etc.
  assert.equal(delays.filter((d) => d === 0).length, 6, `delays: ${delays}`);
  const perStart = (await q(`SELECT slot_start, count(*)::int n FROM time_slots GROUP BY slot_start`)).rows;
  // Invariant: no 1-hour window around any reserved start holds more than capacity.
  for (const { slot_start } of perStart) {
    const n = (await q(`SELECT count(*)::int n FROM time_slots WHERE slot_start >= $1::timestamptz - interval '30 minutes' AND slot_start < $1::timestamptz + interval '30 minutes'`, [slot_start])).rows[0].n;
    assert.ok(n <= cap + 6, `window at ${slot_start.toISOString()} holds ${n}`);
  }
  // Re-reserving the same flight replaces, never duplicates.
  await q(`SELECT reserve_airspace_slot($1, 'AC', 'high', '2030-01-01T15:00:00Z', 60, false)`, [ids[0]]);
  const n0 = (await q(`SELECT count(*)::int n FROM time_slots WHERE flight_intent_id=$1`, [ids[0]])).rows[0].n;
  assert.equal(n0, 1);
});

test("airspace slots at the requested time are capped exactly at capacity", async () => {
  await q(`DELETE FROM time_slots`);
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(await intent({ band: "high" }));
  const clients = await Promise.all(ids.map(() => conn()));
  await Promise.all(ids.map((id, i) => clients[i].query(
    `SELECT reserve_airspace_slot($1, 'AC', 'high', '2030-02-01T12:00:00Z', 60, false)`, [id])));
  await Promise.all(clients.map((c) => c.end()));
  const atStart = (await q(`SELECT count(*)::int n FROM time_slots WHERE slot_start = '2030-02-01T12:00:00Z'`)).rows[0].n;
  assert.equal(atStart, 6);
});

test("expired/landed flights release airspace capacity", async () => {
  await q(`DELETE FROM time_slots`);
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await intent({ band: "high" }));
  for (const id of ids) await q(`SELECT reserve_airspace_slot($1, 'AC', 'high', '2030-03-01T12:00:00Z', 60, false)`, [id]);
  const late = await intent({ band: "high" });
  let r = (await q(`SELECT reserve_airspace_slot($1, 'AC', 'high', '2030-03-01T12:00:00Z', 60, false) r`, [late])).rows[0].r;
  assert.notEqual(r.delay_minutes, 0);
  await q(`UPDATE flight_intents SET status='expired' WHERE id = $1`, [ids[0]]);
  r = (await q(`SELECT reserve_airspace_slot($1, 'AC', 'high', '2030-03-01T12:00:00Z', 60, false) r`, [late])).rows[0].r;
  assert.equal(r.delay_minutes, 0);
});

test("concurrent vertiport reservations respect departure capacity", async () => {
  const o = (await q(`SELECT id, max_departures_per_hour c FROM vertiports WHERE faa_id='6N5'`)).rows[0];
  const d = (await q(`SELECT id FROM vertiports WHERE faa_id='LGA'`)).rows[0];
  const ids = [];
  for (let i = 0; i < 9; i++) ids.push(await intent({ band: "low" }));
  const clients = await Promise.all(ids.map(() => conn()));
  const res = await Promise.all(ids.map((id, i) => clients[i].query(
    `SELECT reserve_vertiport_slots($1, 'AC', $2, $3, '2030-01-01T15:00:00Z', 12) r`, [id, o.id, d.id])));
  await Promise.all(clients.map((c) => c.end()));
  const out = res.map((r) => r.rows[0].r);
  assert.equal(out.filter((r) => r.delay_minutes === 0).length, o.c);
  // 4/hour in a ±30-min window: 4 fit at +0, 4 more at +35; the 9th has no slot
  // within the 60-minute search horizon and must be reported, not squeezed in.
  const reserved = out.filter((r) => r.reserved).length;
  assert.equal(reserved, 2 * o.c);
  const slots = (await q(`SELECT count(*)::int n FROM vertiport_slots WHERE flight_intent_id = ANY($1)`, [ids])).rows[0].n;
  assert.equal(slots, reserved * 2); // exactly one departure + one arrival per reserved flight
  // Invariant: no departure window holds more than capacity.
  const over = (await q(`SELECT count(*)::int n FROM vertiport_slots a WHERE a.vertiport_id=$1 AND a.slot_type='departure'
    AND (SELECT count(*) FROM vertiport_slots b WHERE b.vertiport_id=a.vertiport_id AND b.slot_type='departure'
         AND b.scheduled_time >= a.scheduled_time - interval '30 minutes' AND b.scheduled_time < a.scheduled_time + interval '30 minutes') > $2`, [o.id, o.c])).rows[0].n;
  assert.equal(over, 0);
  // A side without a registered vertiport is reported, not invented.
  const solo = await intent({ band: "low" });
  const r = (await q(`SELECT reserve_vertiport_slots($1, 'AC', NULL, $2, '2030-05-01T15:00:00Z', 12) r`, [solo, d.id])).rows[0].r;
  assert.equal(r.origin, null);
  assert.equal(r.reserved, true);
});

test("flight outcome is recorded exactly once under concurrent calls", async () => {
  const id = await intent({ status: "in_air", band: "low", origin: "Pier A @ 40.70,-74.01", destination: "LGA @ 40.77,-73.87" });
  await q(`SELECT upsert_route_pattern(NULL, 'pier a', 'lga', 'low', 80, 80, 80, 80, 80, '[]'::jsonb)`);
  await q(`SELECT upsert_route_pattern($1, 'pier a', 'lga', 'low', 80, 80, 80, 80, 80, '[]'::jsonb)`, [USER]);
  const payload = JSON.stringify({ aircraft_id: "N1", actual_duration_minutes: 12, planned_duration_minutes: 11, delay_minutes: 2, predicted_overall_score: 80 });
  const clients = await Promise.all([conn(), conn(), conn()]);
  const out = await Promise.all(clients.map((c) => c.query(`SELECT record_flight_outcome_tx($1, $2, $3::jsonb) r`, [USER, id, payload])));
  await Promise.all(clients.map((c) => c.end()));
  const recorded = out.map((r) => r.rows[0].r).filter((r) => !r.already_recorded);
  assert.equal(recorded.length, 1);
  assert.equal((await q(`SELECT count(*)::int n FROM flight_outcomes WHERE flight_intent_id=$1`, [id])).rows[0].n, 1);
  const fleet = (await q(`SELECT completed_flight_count c FROM route_patterns WHERE origin_key='pier a' AND user_id IS NULL`)).rows[0];
  assert.equal(fleet.c, 1);
  const prof = (await q(`SELECT total_flights FROM user_error_profiles WHERE user_id=$1`, [USER])).rows[0];
  assert.equal(prof.total_flights, 1);
  // landed → archived by the existing trigger
  assert.equal((await q(`SELECT status FROM flight_intents WHERE id=$1`, [id])).rows[0].status, "archived");
  // Someone else's flight is refused.
  const foreign = (await q(`SELECT record_flight_outcome_tx($1, $2, '{}'::jsonb) r`, [OTHER, id])).rows[0].r;
  assert.equal(foreign.error, "not_found");
});

test("concurrent route-pattern upserts keep an exact running average", async () => {
  const clients = await Promise.all(Array.from({ length: 20 }, conn));
  await Promise.all(clients.map((c, i) => c.query(
    `SELECT upsert_route_pattern(NULL, 'race o', 'race d', 'mid', $1, 50, 50, 50, 50, '[]'::jsonb)`, [i % 2 ? 100 : 0])));
  await Promise.all(clients.map((c) => c.end()));
  const r = (await q(`SELECT flight_count, avg_overall_score::float a FROM route_patterns WHERE origin_key='race o'`)).rows;
  assert.equal(r.length, 1);
  assert.equal(r[0].flight_count, 20);
  assert.ok(Math.abs(r[0].a - 50) < 1e-9);
});

async function asUser(sub, fn) {
  const c = await conn();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authenticated");
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { await c.end(); }
}

test("clients can only report take-off and landing on their own flights", async () => {
  const id = await intent({ status: "pending", band: "mid" });
  await assert.rejects(asUser(USER, (c) => c.query(`UPDATE flight_intents SET trajectory_score=100 WHERE id=$1`, [id])), /permission denied/);
  await assert.rejects(asUser(USER, (c) => c.query(`UPDATE flight_intents SET status='approved' WHERE id=$1`, [id])), /not allowed/);
  await assert.rejects(asUser(USER, (c) => c.query(
    `INSERT INTO flight_intents (user_id, aircraft_id, operator_name, origin, destination, departure_window_start, departure_window_end)
     VALUES ($1,'X','X','a','b','10:00','10:05')`, [USER])), /permission denied/);
  const other = await asUser(OTHER, (c) => c.query(`UPDATE flight_intents SET status='in_air' WHERE id=$1`, [id]));
  assert.equal(other.rowCount, 0); // RLS: not their row
  await asUser(USER, (c) => c.query(`UPDATE flight_intents SET status='in_air' WHERE id=$1`, [id]));
  await asUser(USER, (c) => c.query(`UPDATE flight_intents SET status='landed', landed_at=now() WHERE id=$1`, [id]));
  assert.equal((await q(`SELECT status FROM flight_intents WHERE id=$1`, [id])).rows[0].status, "archived");
});

test("API roles cannot read ops tables or call privileged functions", async () => {
  for (const t of ["error_events", "api_usage", "alert_events", "geocode_cache", "rate_limits"]) {
    await assert.rejects(asUser(USER, (c) => c.query(`SELECT * FROM ${t} LIMIT 1`)), /permission denied/, t);
  }
  await assert.rejects(asUser(USER, (c) => c.query(`SELECT expire_stale_intents()`)), /permission denied/);
  await assert.rejects(asUser(USER, (c) => c.query(`SELECT reserve_airspace_slot(gen_random_uuid(),'x','low',now(),1,true)`)), /permission denied/);
  await assert.rejects(asUser(USER, (c) => c.query(`SELECT check_rate_limit($1,'x',1,60)`, [OTHER])), /permission denied/);
  await assert.rejects(asUser(USER, (c) => c.query(`SELECT record_flight_outcome_tx($1,gen_random_uuid(),'{}')`, [USER])), /permission denied/);
});

test("stale intents expire and release their reservations", async () => {
  const old = await intent({ status: "pending", band: "mid", start: "2020-01-01T10:00:00Z", end: "2020-01-01T10:10:00Z" });
  await q(`SELECT reserve_airspace_slot($1, 'AC', 'mid', '2020-01-01T10:00:00Z', 60, false)`, [old]);
  const fresh = await intent({ status: "pending", band: "mid", start: "2030-06-01T10:00:00Z", end: "2030-06-01T10:10:00Z" });
  const n = (await q(`SELECT expire_stale_intents() n`)).rows[0].n;
  assert.ok(n >= 1);
  assert.equal((await q(`SELECT status FROM flight_intents WHERE id=$1`, [old])).rows[0].status, "expired");
  assert.equal((await q(`SELECT status FROM flight_intents WHERE id=$1`, [fresh])).rows[0].status, "pending");
  assert.equal((await q(`SELECT status FROM time_slots WHERE flight_intent_id=$1`, [old])).rows[0].status, "cancelled");
});

test("a new decision supersedes the previous one for the same flight", async () => {
  const id = await intent({ band: "mid" });
  await q(`INSERT INTO flight_decisions (flight_intent_id, aircraft_id, decision, reason) VALUES ($1,'A','DELAY','x')`, [id]);
  await q(`INSERT INTO flight_decisions (flight_intent_id, aircraft_id, decision, reason, route_candidate_id) VALUES ($1,'A','REROUTE','y','port-wide')`, [id]);
  const rows = (await q(`SELECT decision, superseded FROM flight_decisions WHERE flight_intent_id=$1 ORDER BY created_at, decision`, [id])).rows;
  assert.deepEqual(rows.map((r) => [r.decision, r.superseded]).sort(), [["DELAY", true], ["REROUTE", false]]);
});

test("alerts: error spike and budget thresholds raise one deduplicated alert", async () => {
  for (let i = 0; i < 12; i++) await q(`INSERT INTO error_events (source, fn, message) VALUES ('edge','route-optimizer','boom')`);
  await q(`SELECT track_api_usage('open-meteo', 7000)`);
  const first = (await q(`SELECT check_alerts() r`)).rows[0].r;
  assert.equal(first.webhook_configured, false);
  await q(`SELECT check_alerts()`);
  const kinds = (await q(`SELECT kind FROM alert_events ORDER BY kind`)).rows.map((r) => r.kind);
  assert.deepEqual(kinds, ["budget_warning", "error_spike"]);
});

test("nightly pattern refresh keys on the place name, not the coordinate tag", async () => {
  await q(`INSERT INTO routes (aircraft_id, operator_name, origin, destination, altitude_band, overall_score, safety_score,
             weather_score, traffic_score, efficiency_score, primary_route)
           VALUES ('A','O','Hoboken Terminal @ 40.7359,-74.0275','JFK @ 40.6413,-73.7781','low',70,60,70,70,70,'{"waypoints":[]}'),
                  ('B','O','hoboken terminal @ 40.7360,-74.0276','JFK @ 40.6413,-73.7781','low',90,80,90,90,90,'{"waypoints":[]}')`);
  const r = (await q(`SELECT refresh_fleet_route_patterns() r`)).rows[0].r;
  assert.ok(r.updated_patterns >= 1);
  const p = (await q(`SELECT avg_overall_score::float a FROM route_patterns WHERE origin_key='hoboken terminal' AND destination_key='jfk' AND user_id IS NULL`)).rows;
  assert.equal(p.length, 1);
  assert.equal(p[0].a, 80);
});

test("rollback script reverts cleanly and the migration re-applies", async () => {
  await q(sqlFile("rollback", "20261102000000_production_readiness.down.sql"));
  const col = (await q(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='flight_intents' AND column_name='departure_start_at'`)).rows[0].n;
  assert.equal(col, 0);
  assert.equal((await q(`SELECT to_regclass('public.error_events') r`)).rows[0].r, null);
  await q(sqlFile("migrations", "20261102000000_production_readiness.sql"));
  assert.equal((await q(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='flight_intents' AND column_name='departure_start_at'`)).rows[0].n, 1);
});
