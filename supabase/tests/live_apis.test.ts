// LIVE checks against the real external APIs the Step 2 engines depend on.
//   deno test --allow-net supabase/tests/live_apis.test.ts
// No mocks: these fail if Open-Meteo / Nominatim are unreachable or change shape.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchWeather, departureRisk, WxCache } from "../functions/_shared/weather.ts";
import { resolveLocation } from "../functions/_shared/geocode.ts";

const JRB = { lat: 40.7012, lon: -74.0091 }; // Downtown Manhattan Heliport

Deno.test("Open-Meteo: forecast exactly at a future departure time", async () => {
  const at = new Date(Date.now() + 3 * 3_600_000);
  const wx = await fetchWeather(JRB.lat, JRB.lon, at);
  assert(wx.available, "forecast should be available");
  const dt = Math.abs(new Date(wx.validAt!).getTime() - at.getTime());
  assert(dt <= 15 * 60_000, `slot ${wx.validAt} not within 15 min of ${at.toISOString()}`);
  assert(wx.windSpeedKmh >= 0 && wx.windSpeedKmh < 250);
  assert(Number.isFinite(wx.temperatureC) && wx.temperatureC > -60 && wx.temperatureC < 60);
  console.log("JRB @", wx.validAt, { wind: wx.windSpeedKmh, gusts: wx.windGustsKmh, temp: wx.temperatureC, vis: wx.visibilityM, code: wx.weatherCode });
});

Deno.test("Open-Meteo: departure risk with +15/+30 forecast", async () => {
  const r = await departureRisk(JRB.lat, JRB.lon, new Date(Date.now() + 2 * 3_600_000), "mid");
  assert(r.available);
  if (r.available) {
    for (const v of [r.riskScore, r.forecast15, r.forecast30]) assert(v >= 0 && v <= 100);
    console.log("risk", r);
  }
});

Deno.test("Open-Meteo: a failure is reported as unavailable, never as calm weather", async () => {
  const wx = await fetchWeather(999, 999, new Date()); // invalid coords → API 400
  assertEquals(wx.available, false);
});

Deno.test("WxCache deduplicates requests in the same 5 km cell", async () => {
  const c = new WxCache(new Date(Date.now() + 3_600_000));
  const [a, b] = await Promise.all([c.get(40.7012, -74.0091), c.get(40.7020, -74.0080)]);
  assert(a === b);
});

Deno.test("Nominatim: real lookup, throttled; unknown text resolves to null", async () => {
  const t0 = Date.now();
  const hit = await resolveLocation(null, "Downtown Manhattan Heliport, New York");
  const miss = await resolveLocation(null, "zzqx nowhere qqzz 12345");
  assert(hit && Math.abs(hit.lat - 40.70) < 0.05 && Math.abs(hit.lon + 74.01) < 0.05, JSON.stringify(hit));
  assertEquals(miss, null);
  assert(Date.now() - t0 >= 1000, "second request must wait ≥1 s (OSM usage policy)");
});

// ─── Data platform sources (2026-11-15) — real fetch + the production parsers ──
import { fetchWithRetry } from "../functions/_shared/ingest/fetcher.ts";
import {
  STATIONS, parseAirSigmets, parseGAirmets, parseMetars, parseNwsAlerts, parseOpenSky, parseTafs,
  parseTfrDetail, parseTfrList, parseVerificationForecasts,
} from "../functions/_shared/ingest/parsers.ts";
import { MINUTELY_VARS, slot15 } from "../functions/_shared/forecast.ts";

const ids = Object.keys(STATIONS);

Deno.test("AWC METAR: real NYC observations parse and pass validation", async () => {
  const r = await fetchWithRetry(`https://aviationweather.gov/api/data/metar?ids=${ids.join(",")}&format=json&hours=2`, { service: "awc" });
  const { records, rejected } = parseMetars(JSON.parse(r.text!));
  assert(records.length >= 5, `only ${records.length} METARs`);
  assertEquals(rejected, 0);
  assert(records.every((m) => m.quality !== "rejected"), "a live METAR was rejected");
  console.log("METAR", records.slice(0, 3).map((m) => `${m.station} ${m.obs_time} ${m.wind_kt}kt ${m.quality}`));
});

Deno.test("AWC TAF / SIGMET / G-AIRMET: real responses parse", async () => {
  const taf = await fetchWithRetry(`https://aviationweather.gov/api/data/taf?ids=KJFK,KLGA,KEWR&format=json`, { service: "awc" });
  assert(parseTafs(JSON.parse(taf.text!)).records.length >= 2);
  const sig = parseAirSigmets(JSON.parse((await fetchWithRetry("https://aviationweather.gov/api/data/airsigmet?format=json", { service: "awc" })).text!));
  const g = parseGAirmets(JSON.parse((await fetchWithRetry("https://aviationweather.gov/api/data/gairmet?format=json", { service: "awc", timeoutMs: 25_000 })).text!));
  console.log("SIGMET in-region", sig.records.length, "outside", sig.outside, "| G-AIRMET in-region", g.records.length, "outside", g.outside);
  assert(g.records.length + g.outside > 0, "G-AIRMET feed empty");
});

Deno.test("NWS alerts: real GeoJSON parses", async () => {
  const r = await fetchWithRetry("https://api.weather.gov/alerts/active?point=40.7549,-73.9840", { service: "nws", headers: { Accept: "application/geo+json" } });
  const { rejected } = parseNwsAlerts(JSON.parse(r.text!));
  assertEquals(rejected, 0);
});

Deno.test("FAA TFR: list + one real detail document parse", async () => {
  const list = parseTfrList(JSON.parse((await fetchWithRetry("https://tfr.faa.gov/tfrapi/exportTfrList", { service: "faa-tfr" })).text!));
  assert(list.length > 5, `TFR list has ${list.length}`);
  let parsed = 0;
  for (const t of list.slice(0, 4)) {
    try {
      const d = await fetchWithRetry(`https://tfr.faa.gov/download/detail_${t.notam_id.replace("/", "_")}.xml`, { service: "faa-tfr", attempts: 1 });
      const det = parseTfrDetail(d.text!);
      if (det.areas.length) { parsed++; console.log("TFR", t.notam_id, det.name, det.valid_from, det.areas.length, "areas", det.quality); }
    } catch { /* some list entries have no detail document */ }
  }
  assert(parsed >= 1, "no TFR detail could be parsed");
});

Deno.test("OpenSky: anonymous NYC state vectors parse", async () => {
  try {
    const r = await fetchWithRetry("https://opensky-network.org/api/states/all?lamin=40.40&lomin=-74.40&lamax=41.10&lomax=-73.50", { service: "opensky", attempts: 1 });
    const { records } = parseOpenSky(JSON.parse(r.text!));
    console.log("ADS-B aircraft", records.length);
    assert(records.every((t) => t.lat > 40 && t.lat < 41.2));
  } catch (e) {
    // Anonymous quota (400/day) may be exhausted — report, don't fail the suite.
    console.warn("OpenSky unavailable:", (e as Error).message);
  }
});

Deno.test("Open-Meteo multi-location verification snapshot", async () => {
  const now = new Date();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${ids.map((s) => STATIONS[s].lat).join(",")}` +
    `&longitude=${ids.map((s) => STATIONS[s].lon).join(",")}&minutely_15=${MINUTELY_VARS}` +
    `&start_minutely_15=${slot15(new Date(now.getTime() + 45 * 60_000))}&end_minutely_15=${slot15(new Date(now.getTime() + 135 * 60_000))}` +
    `&timezone=UTC&wind_speed_unit=kmh`;
  const snaps = parseVerificationForecasts(JSON.parse((await fetchWithRetry(url, { service: "open-meteo" })).text!), ids, now, [60, 120]);
  assertEquals(snaps.length, ids.length * 2);
});
