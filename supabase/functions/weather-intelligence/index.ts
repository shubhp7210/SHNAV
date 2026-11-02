// Weather for the Step 2 clearance, evaluated AT THE DEPARTURE TIME from
// Open-Meteo's 15-minute forecast: departure, +15 min and +30 min at the
// origin, and the destination at the estimated arrival time.
//
// Removed: the invented "urban heat island +2.5 °C / +15 % gusts" adjustment
// and the silent 5 km/h "neutral" defaults. If the forecast can't be fetched
// this returns 503 — the decision engine then refuses to issue a GO.
import { serve, httpError } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody, validateFields } from "../_shared/validate.ts";
import { resolveLocation } from "../_shared/geocode.ts";
import { fetchForecastPoints, computeRisk, riskLevel, weatherCodeToDescription } from "../_shared/weather.ts";
import { pointAt, type WxPoint } from "../_shared/forecast.ts";
import { EVTOL_BASE_SPEED_KMH } from "../_shared/constants.ts";
import { haversineKm } from "../_shared/geo.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const risk = (p: WxPoint) => computeRisk(p.windSpeedKmh, p.windGustsKmh, p.precipitationMm, p.weatherCode);

serve("weather-intelligence", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);
  const rl = await checkRateLimit(admin, user.id, "weather-intelligence", 60, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const body = validateFields(await readBody(req), {
    flight_intent_id: { type: "string", maxLength: 36, pattern: UUID },
    origin:           { type: "string", maxLength: 256 },
    destination:      { type: "string", maxLength: 256 },
    altitude_band:    { type: "string", oneOf: ["low", "mid", "high"] },
    departure_at:     { type: "string", maxLength: 40 },
  }) as Record<string, string | undefined>;

  // Prefer the stored, owned intent (server truth); fall back to explicit inputs.
  let o: { lat: number; lon: number } | null = null, d: { lat: number; lon: number } | null = null;
  let departAt = body.departure_at ? new Date(body.departure_at) : new Date();
  let band = body.altitude_band ?? "low";
  if (body.flight_intent_id) {
    const { data: fi } = await admin.from("flight_intents")
      .select("origin_lat, origin_lon, dest_lat, dest_lon, departure_start_at, altitude_band")
      .eq("id", body.flight_intent_id).eq("user_id", user.id).maybeSingle();
    if (!fi) throw httpError(403, "Flight intent not found or access denied");
    if (fi.origin_lat != null) o = { lat: fi.origin_lat, lon: fi.origin_lon };
    if (fi.dest_lat != null) d = { lat: fi.dest_lat, lon: fi.dest_lon };
    if (fi.departure_start_at) departAt = new Date(fi.departure_start_at);
    band = fi.altitude_band ?? band;
  } else {
    [o, d] = await Promise.all([resolveLocation(admin, body.origin), resolveLocation(admin, body.destination)]);
  }
  if (!Number.isFinite(departAt.getTime())) throw httpError(400, "departure_at is not a valid timestamp");
  if (!o) return json({ error: "weather_unavailable", reason: "Origin location could not be resolved" }, 503);

  const flightMin = d ? (haversineKm(o.lat, o.lon, d.lat, d.lon) / EVTOL_BASE_SPEED_KMH) * 60 : 0;
  const arriveAt = new Date(departAt.getTime() + flightMin * 60_000);
  const [oPts, dPts] = await Promise.all([
    fetchForecastPoints(o.lat, o.lon, departAt),
    d ? fetchForecastPoints(d.lat, d.lon, arriveAt) : Promise.resolve([]),
  ]);
  const now = pointAt(oPts, departAt);
  const p15 = pointAt(oPts, new Date(departAt.getTime() + 15 * 60_000));
  const p30 = pointAt(oPts, new Date(departAt.getTime() + 30 * 60_000));
  const dest = d ? pointAt(dPts, arriveAt) : null;
  if (!now) return json({ error: "weather_unavailable", reason: "Open-Meteo forecast unavailable for the departure time" }, 503);

  // Higher bands see stronger wind; risk is scaled (documented, not hidden).
  const altitudeMultiplier = band === "high" ? 1.3 : band === "mid" ? 1.15 : 1.0;
  const base = risk(now);
  const scaled = (r: number) => Math.min(100, Math.round(r * altitudeMultiplier));
  const r0 = scaled(base);
  const r15 = p15 ? scaled(risk(p15)) : r0;
  const r30 = p30 ? scaled(risk(p30)) : r15;
  const spread = Math.abs(r30 - r0);

  let recommendation: "proceed" | "delay" | "reroute" = "proceed";
  let reason = "Conditions at departure are within limits.";
  let delayMin = 0;
  let altBand: string | null = null;
  if (r0 >= 60) {
    if (r30 < r0 - 15) { recommendation = "delay"; delayMin = 30; reason = `High risk at departure (${r0}/100); forecast improves to ${r30}/100 by +30 min.`; }
    else { recommendation = "reroute"; altBand = band === "high" ? "mid" : band === "mid" ? "low" : "mid"; reason = `High risk at departure (${r0}/100) with no improvement forecast.`; }
  } else if (r0 >= 35) {
    if (r15 < r0 - 10) { recommendation = "delay"; delayMin = 15; reason = `Moderate risk (${r0}/100) improving to ${r15}/100 within 15 min.`; }
    else reason = `Moderate risk (${r0}/100), stable — proceed with caution.`;
  }

  return json({
    data_status: "live",
    source: "open-meteo minutely_15",
    valid_at: now.time,
    origin_weather: {
      wind_speed: Math.round(now.windSpeedKmh),
      wind_direction_deg: Math.round(now.windFromDeg),
      wind_gusts: Math.round(now.windGustsKmh),
      precipitation: now.precipitationMm,
      temperature: Number.isFinite(now.temperatureC) ? Math.round(now.temperatureC) : null,
      weather_code: now.weatherCode,
      weather_description: weatherCodeToDescription(now.weatherCode),
      visibility_m: Number.isFinite(now.visibilityM) ? Math.round(now.visibilityM) : null,
      risk_score: r0,
      risk_level: riskLevel(r0),
      micro_effects: [],
    },
    destination_weather: dest ? {
      wind_speed: Math.round(dest.windSpeedKmh),
      wind_gusts: Math.round(dest.windGustsKmh),
      precipitation: dest.precipitationMm,
      weather_code: dest.weatherCode,
      risk_score: risk(dest),
      risk_level: riskLevel(risk(dest)),
      weather_description: weatherCodeToDescription(dest.weatherCode),
      valid_at: dest.time,
    } : null,
    forecast: {
      // Uncertainty grows with lead time and with forecast volatility.
      t_plus_15: { risk_score: r15, uncertainty_pct: Math.round(Math.min(25, 8 + spread * 0.3)) },
      t_plus_30: { risk_score: r30, uncertainty_pct: Math.round(Math.min(40, 15 + spread * 0.5)) },
      trend: r30 < r0 ? "improving" : r30 > r0 ? "degrading" : "stable",
    },
    recommendation,
    recommendation_reason: reason,
    suggested_delay_minutes: delayMin,
    suggested_altitude_band: altBand,
    altitude_risk_modifier: altitudeMultiplier,
  });
});
