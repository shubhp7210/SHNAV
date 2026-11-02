// Open-Meteo 15-minute forecast parsing (pure).
//
// Weather is evaluated AT THE DEPARTURE TIME using Open-Meteo's `minutely_15`
// forecast (native 15-min data over North America), plus +15 and +30 min.
// The previous code used "current" conditions regardless of when the flight
// departs, and labelled the current hour's value as "t+15".

export interface WxPoint {
  time: string;            // ISO (UTC) of the forecast slot
  windSpeedKmh: number;
  windFromDeg: number;
  windGustsKmh: number;
  precipitationMm: number;
  temperatureC: number;
  weatherCode: number;
  visibilityM: number;
}

export const MINUTELY_VARS =
  "temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,visibility,weather_code";

const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DDTHH:MM" in UTC, floored to the 15-minute grid. */
export function slot15(d: Date): string {
  const t = new Date(Math.floor(d.getTime() / 900_000) * 900_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** Forecast URL covering [at, at+45 min] on the 15-minute grid. */
export function forecastUrl(lat: number, lon: number, at: Date): string {
  const start = slot15(at);
  const end = slot15(new Date(at.getTime() + 45 * 60_000));
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&minutely_15=${MINUTELY_VARS}&start_minutely_15=${start}&end_minutely_15=${end}` +
    `&timezone=UTC&wind_speed_unit=kmh`;
}

/** Parse the response into points; returns [] when any required field is missing
 *  (never fills gaps with invented "neutral" weather). */
export function parseMinutely(json: unknown): WxPoint[] {
  const m = (json as { minutely_15?: Record<string, unknown[]> })?.minutely_15;
  if (!m || !Array.isArray(m.time)) return [];
  const out: WxPoint[] = [];
  for (let i = 0; i < m.time.length; i++) {
    const num = (k: string) => {
      const v = (m[k] as unknown[] | undefined)?.[i];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const p = {
      ws: num("wind_speed_10m"), wd: num("wind_direction_10m"), wg: num("wind_gusts_10m"),
      pr: num("precipitation"), t: num("temperature_2m"), wc: num("weather_code"), vis: num("visibility"),
    };
    if (p.ws == null || p.wg == null || p.pr == null || p.wc == null) continue; // core fields required
    out.push({
      time: `${m.time[i]}Z`.replace(/Z+$/, "Z"),
      windSpeedKmh: p.ws, windFromDeg: p.wd ?? 0, windGustsKmh: p.wg, precipitationMm: p.pr,
      temperatureC: p.t ?? NaN, weatherCode: p.wc, visibilityM: p.vis ?? NaN,
    });
  }
  return out;
}

/** The forecast slot nearest to `at` (within 15 min), or null. */
export function pointAt(points: WxPoint[], at: Date): WxPoint | null {
  let best: WxPoint | null = null, bestDt = Infinity;
  for (const p of points) {
    const dt = Math.abs(new Date(p.time).getTime() - at.getTime());
    if (dt < bestDt) { bestDt = dt; best = p; }
  }
  return best && bestDt <= 15 * 60_000 ? best : null;
}
