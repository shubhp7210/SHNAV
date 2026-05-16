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

export interface WeatherSample {
  windSpeedKmh: number;
  windFromDeg: number;
  windGustsKmh: number;
  precipitationMm: number;
  temperatureC: number;
  weatherCode: number;
  visibilityM: number;
}

/** Neutral weather used when the upstream call fails. */
export const NEUTRAL_WX: WeatherSample = {
  windSpeedKmh: 5,
  windFromDeg: 0,
  windGustsKmh: 7,
  precipitationMm: 0,
  temperatureC: 18,
  weatherCode: 0,
  visibilityM: 10000,
};

/** One-shot Open-Meteo `current` weather fetch. */
export async function fetchWeather(lat: number, lon: number): Promise<WeatherSample> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,visibility,weather_code&wind_speed_unit=kmh&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return { ...NEUTRAL_WX };
    const json = await res.json();
    const c = json?.current ?? {};
    return {
      windSpeedKmh:    Number.isFinite(c.wind_speed_10m)     ? c.wind_speed_10m     : NEUTRAL_WX.windSpeedKmh,
      windFromDeg:     Number.isFinite(c.wind_direction_10m) ? c.wind_direction_10m : NEUTRAL_WX.windFromDeg,
      windGustsKmh:    Number.isFinite(c.wind_gusts_10m)     ? c.wind_gusts_10m     : NEUTRAL_WX.windGustsKmh,
      precipitationMm: Number.isFinite(c.precipitation)      ? c.precipitation      : NEUTRAL_WX.precipitationMm,
      temperatureC:    Number.isFinite(c.temperature_2m)     ? c.temperature_2m     : NEUTRAL_WX.temperatureC,
      weatherCode:     Number.isFinite(c.weather_code)       ? c.weather_code       : NEUTRAL_WX.weatherCode,
      visibilityM:     Number.isFinite(c.visibility)         ? c.visibility         : NEUTRAL_WX.visibilityM,
    };
  } catch {
    return { ...NEUTRAL_WX };
  }
}

interface WxCacheEntry {
  wx: WeatherSample;
  ts: number;
}

/** Per-instance Open-Meteo cache. Buckets queries into ~5 km grid cells so
 *  multiple route candidates sampling nearby points share fetches. Also
 *  deduplicates in-flight requests via the promise map. */
export class WxCache {
  private inflight = new Map<string, Promise<WeatherSample>>();
  private resolved = new Map<string, WxCacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  private key(lat: number, lon: number): string {
    // 0.05° ≈ 5.5 km at mid latitudes.
    return `${Math.round(lat * 20) / 20},${Math.round(lon * 20) / 20}`;
  }

  async get(lat: number, lon: number): Promise<WeatherSample> {
    const k = this.key(lat, lon);
    const cached = this.resolved.get(k);
    if (cached && Date.now() - cached.ts < this.ttlMs) return cached.wx;
    const existing = this.inflight.get(k);
    if (existing) return existing;
    const p = fetchWeather(lat, lon).then((wx) => {
      this.resolved.set(k, { wx, ts: Date.now() });
      this.inflight.delete(k);
      return wx;
    });
    this.inflight.set(k, p);
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
  if (wx.visibilityM < 3000) s += 0.3;
  else if (wx.visibilityM < 6000) s += 0.1;
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
  if (wx.temperatureC > 4) return 0;
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
