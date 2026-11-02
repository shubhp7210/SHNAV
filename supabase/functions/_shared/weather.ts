// Shared Open-Meteo weather fetcher with grid-bucketed caching and the two
// canonical risk-scoring scales used across the platform.
//
// Two risk forms are exported deliberately:
//   - computeRisk(...)      → 0..100 integer (used by weather-intelligence,
//                              flight-decision-engine, UI surfaces)
//   - weatherSeverity(...)  → 0..1     float   (used by route-optimizer's
//                              per-leg cost terms, blends with other 0..1
//                              cost axes like turbulence)
//
// Both consult the same input thresholds — bringing the previously divergent
// thresholds (e.g. "moderate wind" was >20 / >25 / >30 km/h in three different
// functions) into one place.

import { forecastUrl, parseMinutely, pointAt } from "./forecast.ts";
import { countCall } from "./log.ts";

export interface WeatherSample {
  /** false = the upstream call failed; the numbers are NOT observations. */
  available: boolean;
  /** Forecast slot (UTC ISO) the values are valid for. */
  validAt: string | null;
  windSpeedKmh: number;
  windFromDeg: number;
  windGustsKmh: number;
  precipitationMm: number;
  temperatureC: number;
  weatherCode: number;
  visibilityM: number;
}

/** Placeholder returned when weather is unavailable. `available: false` must be
 *  honoured by every caller — these values are never presented as data. */
export const UNAVAILABLE_WX: WeatherSample = {
  available: false, validAt: null,
  windSpeedKmh: 0, windFromDeg: 0, windGustsKmh: 0, precipitationMm: 0,
  temperatureC: NaN, weatherCode: 0, visibilityM: NaN,
};

/** Forecast points (15-min grid) covering [at, at+45 min]; [] on failure. */
export async function fetchForecastPoints(lat: number, lon: number, at: Date) {
  try {
    countCall("open-meteo");
    const res = await fetch(forecastUrl(lat, lon, at), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return parseMinutely(await res.json());
  } catch {
    return [];
  }
}

/** Weather at `at` (default: now) from Open-Meteo's 15-minute forecast. */
export async function fetchWeather(lat: number, lon: number, at: Date = new Date()): Promise<WeatherSample> {
  const p = pointAt(await fetchForecastPoints(lat, lon, at), at);
  if (!p) return { ...UNAVAILABLE_WX };
  return {
    available: true, validAt: p.time,
    windSpeedKmh: p.windSpeedKmh, windFromDeg: p.windFromDeg, windGustsKmh: p.windGustsKmh,
    precipitationMm: p.precipitationMm, temperatureC: p.temperatureC, weatherCode: p.weatherCode,
    visibilityM: p.visibilityM,
  };
}

/** Per-request cache bucketing samples into ~5 km cells, all evaluated at the
 *  same instant (the flight's departure time). Deduplicates in-flight requests. */
export class WxCache {
  private inflight = new Map<string, Promise<WeatherSample>>();
  constructor(private readonly at: Date = new Date()) {}
  private key(lat: number, lon: number): string {
    return `${Math.round(lat * 20) / 20},${Math.round(lon * 20) / 20}`;
  }
  get(lat: number, lon: number): Promise<WeatherSample> {
    const k = this.key(lat, lon);
    let p = this.inflight.get(k);
    if (!p) { p = fetchWeather(lat, lon, this.at); this.inflight.set(k, p); }
    return p;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Risk scoring (two canonical forms)
// ───────────────────────────────────────────────────────────────────────────

/** 0..100 risk score. Higher = more hazardous. Used by surfaces that report
 *  a single risk number to the user / decision engine. */
export function computeRisk(
  windSpeedKmh: number,
  gustsKmh: number,
  precipitationMm: number,
  weatherCode: number,
): number {
  let risk = 0;
  // Wind
  if (windSpeedKmh > 50) risk += 40;
  else if (windSpeedKmh > 35) risk += 25;
  else if (windSpeedKmh > 20) risk += 12;
  else if (windSpeedKmh > 10) risk += 4;
  // Gusts
  if (gustsKmh > 60) risk += 30;
  else if (gustsKmh > 40) risk += 18;
  else if (gustsKmh > 25) risk += 8;
  // Precipitation
  if (precipitationMm > 5) risk += 20;
  else if (precipitationMm > 2) risk += 12;
  else if (precipitationMm > 0.5) risk += 5;
  // Weather code
  if (weatherCode >= 95) risk += 30; // Thunderstorm
  else if (weatherCode >= 80) risk += 15; // Showers
  else if (weatherCode >= 61) risk += 10; // Rain
  else if (weatherCode >= 51) risk += 6; // Drizzle
  return Math.min(100, risk);
}

/** Bucketed risk label derived from `computeRisk`. */
export function riskLevel(score: number): "low" | "moderate" | "high" {
  if (score >= 60) return "high";
  if (score >= 30) return "moderate";
  return "low";
}

/** 0..1 per-leg weather severity. Used by route-optimizer where this term
 *  is blended additively with other 0..1 cost axes (turbulence, icing). */
export function weatherSeverity(wx: WeatherSample): number {
  let s = 0;
  if (wx.windSpeedKmh > 60) s += 0.5;
  else if (wx.windSpeedKmh > 40) s += 0.3;
  else if (wx.windSpeedKmh > 25) s += 0.15;
  if (wx.windGustsKmh > 70) s += 0.4;
  else if (wx.windGustsKmh > 45) s += 0.2;
  else if (wx.windGustsKmh > 30) s += 0.1;
  if (wx.precipitationMm > 5) s += 0.3;
  else if (wx.precipitationMm > 1) s += 0.15;
  else if (wx.precipitationMm > 0.2) s += 0.05;
  if (wx.weatherCode >= 95) s += 0.6; // thunderstorm
  else if (wx.weatherCode >= 71) s += 0.3; // snow
  else if (wx.weatherCode >= 61) s += 0.15; // rain
  else if (wx.weatherCode >= 51) s += 0.06; // drizzle
  if (Number.isFinite(wx.visibilityM)) {
    if (wx.visibilityM < 3000) s += 0.3;
    else if (wx.visibilityM < 6000) s += 0.1;
  }
  return Math.min(1, s);
}

/** 0..1 turbulence proxy from gusts + crosswind. */
export function turbulenceFromGustCross(gustsKmh: number, crosswindKmh: number): number {
  const g = Math.min(1, gustsKmh / 70);
  const c = Math.min(1, crosswindKmh / 30);
  return Math.min(1, g * 0.55 + c * 0.65);
}

/** 0..1 icing probability proxy from temperature + precipitation + weather code. */
export function icingFromWeather(wx: WeatherSample): number {
  if (!Number.isFinite(wx.temperatureC) || wx.temperatureC > 4) return 0;
  let p = 0;
  if (wx.temperatureC <= -2 && wx.precipitationMm > 0) p += 0.6;
  else if (wx.temperatureC <= 2 && wx.precipitationMm > 0) p += 0.35;
  if (wx.weatherCode >= 56 && wx.weatherCode <= 67) p += 0.2; // freezing rain codes
  return Math.min(1, p);
}

/** Human-readable label for an Open-Meteo weather code. */
export function weatherCodeToDescription(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 9) return "Overcast";
  if (code <= 19) return "Fog";
  if (code <= 29) return "Drizzle";
  if (code <= 39) return "Freezing drizzle";
  if (code <= 49) return "Fog";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 84) return "Rain showers";
  if (code <= 94) return "Snow showers";
  return "Thunderstorm";
}

/** Departure-time risk at a point: departure, +15, +30 min (0..100, scaled by
 *  altitude band). `available: false` when the forecast can't be fetched. */
export async function departureRisk(lat: number, lon: number, at: Date, band: string): Promise<
  { available: false } |
  { available: true; riskScore: number; forecast15: number; forecast30: number; trend: "improving" | "degrading" | "stable"; validAt: string }
> {
  const pts = await fetchForecastPoints(lat, lon, at);
  const p0 = pointAt(pts, at);
  if (!p0) return { available: false };
  const mult = band === "high" ? 1.3 : band === "mid" ? 1.15 : 1.0;
  const r = (p: { windSpeedKmh: number; windGustsKmh: number; precipitationMm: number; weatherCode: number }) =>
    Math.min(100, Math.round(computeRisk(p.windSpeedKmh, p.windGustsKmh, p.precipitationMm, p.weatherCode) * mult));
  const p15 = pointAt(pts, new Date(at.getTime() + 15 * 60_000)) ?? p0;
  const p30 = pointAt(pts, new Date(at.getTime() + 30 * 60_000)) ?? p15;
  const r0 = r(p0), r30 = r(p30);
  return {
    available: true, riskScore: r0, forecast15: r(p15), forecast30: r30, validAt: p0.time,
    trend: r30 < r0 ? "improving" : r30 > r0 ? "degrading" : "stable",
  };
}
