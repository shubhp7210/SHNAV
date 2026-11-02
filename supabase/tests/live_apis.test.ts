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
