// Scheduled ingestion of real aviation data. Called every minute by pg_cron
// (public.dispatch_ingest → pg_net) with the internal secret and the list of
// due sources; can also be run by hand: {"sources":["awc-metar"],"force":true}.
//
// For each source: claim a lease (ingest_claim — only one worker at a time),
// check the daily budget, fetch with retries/conditional headers, validate,
// insert append-only with content-hash dedupe, then record the run
// (ingest_finish — which also schedules the next run or the backoff).
import { serve, type SupabaseClient } from "../_shared/http.ts";
import { requireInternalSecret } from "../_shared/auth.ts";
import { logInfo, reportError } from "../_shared/log.ts";
import { contentHash, fetchWithRetry, IngestHttpError } from "../_shared/ingest/fetcher.ts";
import {
  STATIONS, parseAirSigmets, parseGAirmets, parseMetars, parseNwsAlerts, parseOpenSky, parseTafs,
  parseTfrDetail, parseTfrList, parseVerificationForecasts, touchesRegion,
} from "../_shared/ingest/parsers.ts";
import { MINUTELY_VARS, slot15 } from "../_shared/forecast.ts";

interface Claim { run_id: number; source: string; url: string; etag: string | null; last_modified: string | null; budget_service: string | null }
interface RunResult {
  status: "ok" | "not_modified" | "partial"; http?: number; seen: number; inserted: number; duplicate: number;
  rejected: number; etag?: string | null; lastModified?: string | null; lastDataAt?: string | null; note?: string;
}
type Adapter = (admin: SupabaseClient, c: Claim) => Promise<RunResult>;

const maxIso = (xs: (string | null | undefined)[]) => xs.filter(Boolean).sort().slice(-1)[0] ?? null;

/** Append-only insert; duplicates (same content) are ignored and counted. */
async function insertDedup(admin: SupabaseClient, table: string, rows: Record<string, unknown>[], onConflict: string) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error } = await admin.from(table).upsert(chunk, { onConflict, ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`${table} insert failed: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  return { inserted, duplicate: rows.length - inserted };
}

async function budgetAllows(admin: SupabaseClient, service: string | null, calls = 1): Promise<boolean> {
  if (!service) return true;
  const { data, error } = await admin.rpc("budget_allows", { p_service: service, p_calls: calls });
  return error ? true : data === true;   // fail open on a metering error, never on a real limit
}

const json = (text: string | null) => (text ? JSON.parse(text) : null);
const STATION_IDS = Object.keys(STATIONS);

const adapters: Record<string, Adapter> = {
  "awc-metar": async (admin, c) => {
    const r = await fetchWithRetry(`${c.url}?ids=${STATION_IDS.join(",")}&format=json&hours=3`, { service: "awc" });
    const { records, rejected } = parseMetars(json(r.text));
    const rows = await Promise.all(records.map(async (m) => ({
      ...m, source_id: c.source, content_hash: await contentHash([m.station, m.obs_time, m.raw]),
    })));
    const ins = await insertDedup(admin, "wx_metar", rows, "station,obs_time,content_hash");
    return { status: "ok", http: r.status, seen: records.length + rejected, rejected, ...ins,
      lastDataAt: maxIso(records.filter((m) => m.quality !== "rejected").map((m) => m.obs_time)) };
  },

  "awc-taf": async (admin, c) => {
    const ids = STATION_IDS.filter((s) => s !== "KNYC");
    const r = await fetchWithRetry(`${c.url}?ids=${ids.join(",")}&format=json`, { service: "awc" });
    const { records, rejected } = parseTafs(json(r.text));
    const rows = await Promise.all(records.map(async (t) => ({
      ...t, source_id: c.source, content_hash: await contentHash([t.station, t.issue_time, t.raw]),
    })));
    const ins = await insertDedup(admin, "wx_taf", rows, "station,issue_time,content_hash");
    return { status: "ok", http: r.status, seen: records.length + rejected, rejected, ...ins, lastDataAt: maxIso(records.map((t) => t.issue_time)) };
  },

  "awc-airsigmet": async (admin, c) => {
    const r = await fetchWithRetry(`${c.url}?format=json`, { service: "awc" });
    const { records, rejected, outside } = parseAirSigmets(json(r.text));
    return advisoryInsert(admin, c, records, rejected, r.status, `${outside} outside region`);
  },

  "awc-gairmet": async (admin, c) => {
    const r = await fetchWithRetry(`${c.url}?format=json`, { service: "awc", timeoutMs: 25_000 });
    const { records, rejected, outside } = parseGAirmets(json(r.text));
    return advisoryInsert(admin, c, records, rejected, r.status, `${outside} outside region`);
  },

  "nws-alerts": async (admin, c) => {
    // Alerts for Midtown Manhattan (zone + polygon alerts that include it).
    const r = await fetchWithRetry(`${c.url}?point=40.7549,-73.9840`, {
      service: "nws", headers: { Accept: "application/geo+json" }, etag: c.etag, lastModified: c.last_modified,
    });
    if (r.notModified) return { status: "not_modified", http: 304, seen: 0, inserted: 0, duplicate: 0, rejected: 0 };
    const { records, rejected } = parseNwsAlerts(json(r.text));
    const out = await advisoryInsert(admin, c, records, rejected, r.status);
    return { ...out, etag: r.etag, lastModified: r.lastModified };
  },

  "faa-tfr": async (admin, c) => {
    const r = await fetchWithRetry(c.url, { service: "faa-tfr" });
    const list = parseTfrList(json(r.text));
    if (!list.length) throw new IngestHttpError("TFR list empty or unparseable — refusing to withdraw everything", r.status);
    const states = (Deno.env.get("TFR_STATES") ?? "NY,NJ,CT,PA").split(",").map((s) => s.trim().toUpperCase());
    const regional = list.filter((t) => !t.state || states.includes(t.state.toUpperCase()));
    await admin.rpc("withdraw_missing_restrictions", { p_source: c.source, p_seen: list.map((t) => t.notam_id) });

    const { data: known } = await admin.from("airspace_restrictions").select("external_id")
      .eq("source_id", c.source).is("withdrawn_at", null).in("external_id", regional.map((t) => t.notam_id));
    const knownIds = new Set((known ?? []).map((k: { external_id: string }) => k.external_id));
    const todo = regional.filter((t) => !knownIds.has(t.notam_id)).slice(0, 15);
    let inserted = 0, duplicate = 0, rejected = 0, failed = 0, outside = 0;
    for (const t of todo) {
      if (!(await budgetAllows(admin, "faa-tfr"))) break;
      try {
        const d = await fetchWithRetry(`https://tfr.faa.gov/download/detail_${t.notam_id.replace("/", "_")}.xml`, { service: "faa-tfr", attempts: 2 });
        const detail = parseTfrDetail(d.text ?? "");
        if (detail.quality === "rejected") { rejected++; continue; }
        if (!touchesRegion(detail.areas.flatMap((a) => a.points))) { outside++; continue; }
        const row = {
          source_id: c.source, external_id: t.notam_id, kind: "TFR", restriction_type: t.type, name: detail.name ?? t.description,
          state: t.state, facility: t.facility, valid_from: detail.valid_from, valid_to: detail.valid_to,
          alt_low_ft: detail.alt_low_ft, alt_high_ft: detail.alt_high_ft, areas: detail.areas,
          description: detail.description?.slice(0, 4000) ?? t.description, quality: detail.quality, quality_flags: detail.quality_flags,
          content_hash: await contentHash([t.notam_id, detail.valid_from, detail.valid_to, detail.areas]),
        };
        const ins = await insertDedup(admin, "airspace_restrictions", [row], "source_id,external_id,content_hash");
        inserted += ins.inserted; duplicate += ins.duplicate;
        if (ins.duplicate) {   // re-published after a withdrawal
          await admin.from("airspace_restrictions").update({ withdrawn_at: null, last_seen_at: new Date().toISOString() })
            .eq("source_id", c.source).eq("external_id", t.notam_id).eq("content_hash", row.content_hash);
        }
      } catch {
        failed++;
      }
    }
    return { status: failed ? "partial" : "ok", http: r.status, seen: list.length, inserted, duplicate, rejected,
      note: `${regional.length} regional, ${todo.length} fetched, ${outside} outside region, ${failed} detail failures`,
      lastDataAt: new Date().toISOString() };
  },

  "opensky": async (admin, c) => {
    const headers: Record<string, string> = {};
    const token = await openSkyToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetchWithRetry(`${c.url}?lamin=40.40&lomin=-74.40&lamax=41.10&lomax=-73.50`, { service: "opensky", headers, attempts: 2 });
    const { records, rejected } = parseOpenSky(json(r.text));
    const rows = records.map((t) => ({ ...t, source_id: c.source }));
    const ins = await insertDedup(admin, "traffic_observations", rows, "icao24,observed_at");
    return { status: "ok", http: r.status, seen: records.length + rejected, rejected, ...ins,
      lastDataAt: maxIso(records.map((t) => t.observed_at)) };
  },

  "open-meteo-verif": async (admin, c) => {
    const now = new Date();
    const lat = STATION_IDS.map((s) => STATIONS[s].lat.toFixed(4)).join(",");
    const lon = STATION_IDS.map((s) => STATIONS[s].lon.toFixed(4)).join(",");
    const url = `${c.url}?latitude=${lat}&longitude=${lon}&minutely_15=${MINUTELY_VARS}` +
      `&start_minutely_15=${slot15(new Date(now.getTime() + 45 * 60_000))}&end_minutely_15=${slot15(new Date(now.getTime() + 135 * 60_000))}` +
      `&timezone=UTC&wind_speed_unit=kmh`;
    const r = await fetchWithRetry(url, { service: "open-meteo" });
    const snaps = parseVerificationForecasts(json(r.text), STATION_IDS, now, [60, 120]);
    const fetchedAt = now.toISOString();
    const rows = await Promise.all(snaps.map(async (s) => ({
      ...s, source_id: c.source, purpose: "verification", fetched_at: fetchedAt,
      content_hash: await contentHash([s.station, s.valid_at, s.lead_minutes, s.wind_kmh, s.gust_kmh, slot15(now)]),
    })));
    const ins = await insertDedup(admin, "wx_forecast_snapshots", rows, "source_id,purpose,content_hash");
    return { status: snaps.length ? "ok" : "partial", http: r.status, seen: snaps.length, rejected: 0, ...ins,
      note: snaps.length ? undefined : "no forecast slots matched", lastDataAt: maxIso(snaps.map((s) => s.valid_at)) };
  },
};

async function advisoryInsert(admin: SupabaseClient, c: Claim, records: Awaited<ReturnType<typeof parseAirSigmets>>["records"],
  rejected: number, http: number, note?: string): Promise<RunResult> {
  const rows = await Promise.all(records.map(async (a) => ({
    ...a, source_id: c.source,
    content_hash: await contentHash([a.external_id, a.valid_from, a.valid_to, a.hazard, a.polygon, a.raw]),
  })));
  const ins = await insertDedup(admin, "wx_advisories", rows, "source_id,external_id,content_hash");
  return { status: "ok", http, seen: records.length + rejected, rejected, ...ins, note, lastDataAt: new Date().toISOString() };
}

// OpenSky OAuth2 client-credentials (optional; anonymous otherwise).
let osToken: { value: string; exp: number } | null = null;
async function openSkyToken(): Promise<string | null> {
  const id = Deno.env.get("OPENSKY_CLIENT_ID"), secret = Deno.env.get("OPENSKY_CLIENT_SECRET");
  if (!id || !secret) return null;
  if (osToken && osToken.exp > Date.now() + 60_000) return osToken.value;
  const res = await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) { await res.body?.cancel(); return null; }
  const j = await res.json();
  osToken = { value: j.access_token, exp: Date.now() + Number(j.expires_in ?? 1800) * 1000 };
  return osToken.value;
}

async function runSource(admin: SupabaseClient, source: string, force: boolean) {
  const { data: claim, error } = await admin.rpc("ingest_claim", { p_source: source, p_force: force });
  if (error) throw new Error(`ingest_claim failed: ${error.message}`);
  if (!claim) return { source, status: "not_claimed" };
  const c = claim as Claim;
  const finish = (p: Record<string, unknown>) => admin.rpc("ingest_finish", { p_run: c.run_id, ...p });
  if (!(await budgetAllows(admin, c.budget_service))) {
    await finish({ p_status: "skipped", p_error: `daily budget for ${c.budget_service} reached` });
    return { source, status: "skipped", reason: "budget" };
  }
  try {
    const r = await adapters[source](admin, c);
    await finish({
      p_status: r.status, p_http: r.http ?? null, p_seen: r.seen, p_inserted: r.inserted, p_duplicate: r.duplicate,
      p_rejected: r.rejected, p_error: r.note ?? null, p_etag: r.etag ?? null, p_last_modified: r.lastModified ?? null,
      p_last_data_at: r.lastDataAt ?? null,
    });
    return { source, ...r };
  } catch (e) {
    const http = e instanceof IngestHttpError ? e.status : null;
    const retry = e instanceof IngestHttpError ? e.retryAfterS : null;
    const msg = e instanceof Error ? e.message : String(e);
    await finish({ p_status: "error", p_http: http, p_error: msg, p_retry_after_s: retry });
    await reportError(admin, "data-ingest", e, { source }, null, "warning");
    return { source, status: "error", error: msg };
  }
}

serve("data-ingest", async ({ req, admin, json: reply }) => {
  requireInternalSecret(req);
  let body: { sources?: unknown; force?: unknown } = {};
  try { body = JSON.parse((await req.text()) || "{}"); } catch { /* empty body = all due sources */ }
  const force = body.force === true;
  let sources: string[];
  if (Array.isArray(body.sources)) {
    sources = body.sources.filter((s): s is string => typeof s === "string" && s in adapters);
  } else {
    const { data, error } = await admin.rpc("ingest_due_sources");
    if (error) throw new Error(`ingest_due_sources failed: ${error.message}`);
    sources = ((data ?? []) as string[]).filter((s) => s in adapters);
  }
  const deadline = Date.now() + 50_000;
  const results = [];
  for (const s of sources) {
    if (Date.now() > deadline) { results.push({ source: s, status: "deferred" }); continue; }
    results.push(await runSource(admin, s, force));
  }
  logInfo("data-ingest", "run", { results: results.map((r) => `${r.source}:${r.status}`) });
  return reply({ results });
});
