// Pure route checks against REAL external data: FAA TFRs, SIGMET/AIRMET/
// G-AIRMET/NWS advisories and live ADS-B traffic, plus the forecast-vs-METAR
// cross-check. Used by route-optimizer, trajectory-analysis and
// weather-intelligence; unit-tested in src/lib/airspace.test.ts.

export interface LatLon { lat: number; lon: number }

/** Nominal display heights per band (m AGL) + 100 ft buffer, in feet. The
 *  backend defines bands by name only, so these are illustrative ceilings. */
export const BAND_CEILING_FT: Record<string, number> = { low: 120 * 3.28084 + 100, mid: 250 * 3.28084 + 100, high: 400 * 3.28084 + 100 };
export const bandCeilingFt = (band: string | null | undefined) => BAND_CEILING_FT[band ?? "low"] ?? BAND_CEILING_FT.low;

// ─── Geometry ───────────────────────────────────────────────────────────────
export function pointInPolygon(p: LatLon, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) &&
        p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
function segIntersect(p1: LatLon, p2: LatLon, p3: LatLon, p4: LatLon): boolean {
  const d = (a: LatLon, b: LatLon, c: LatLon) => (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
/** True when any part of the polyline lies inside the polygon. */
export function pathIntersectsPolygon(path: LatLon[], poly: LatLon[]): boolean {
  if (poly.length < 3 || path.length === 0) return false;
  if (path.some((p) => pointInPolygon(p, poly))) return true;
  for (let i = 0; i + 1 < path.length; i++) {
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      if (segIntersect(path[i], path[i + 1], poly[k], poly[j])) return true;
    }
  }
  return false;
}
export function haversineM(a: LatLon, b: LatLon): number {
  const R = 6_371_000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Min distance (m) from a point to a polyline (local equirectangular projection). */
export function distToPathM(p: LatLon, path: LatLon[]): number {
  if (path.length === 1) return haversineM(p, path[0]);
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111_320, ky = 110_540;
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const ax = (path[i].lon - p.lon) * kx, ay = (path[i].lat - p.lat) * ky;
    const bx = (path[i + 1].lon - p.lon) * kx, by = (path[i + 1].lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// ─── TFRs ───────────────────────────────────────────────────────────────────
export interface RestrictionRow {
  id: number; external_id: string; name: string | null; restriction_type: string | null;
  valid_from: string | null; valid_to: string | null; alt_low_ft: number | null; alt_high_ft: number | null;
  areas: { alt_low_ft: number | null; alt_high_ft: number | null; points: LatLon[] }[];
  quality: string; quality_flags: string[]; fetched_at: string;
}
export interface RestrictionHit {
  source: "faa-tfr"; notam: string; name: string | null; type: string | null;
  valid_from: string | null; valid_to: string | null; alt_low_ft: number | null; alt_high_ft: number | null;
  geometry_approximated: boolean; severity: "high";
}

const overlaps = (aFrom: number, aTo: number, bFrom: string | null, bTo: string | null) =>
  (bFrom == null || Date.parse(bFrom) <= aTo) && (bTo == null || Date.parse(bTo) >= aFrom);

/** TFRs active in [startMs, endMs] whose floor is below the band ceiling and
 *  whose area the route enters. Any hit is a hard restriction. */
export function routeRestrictionHits(path: LatLon[], startMs: number, endMs: number, band: string, rows: RestrictionRow[]): RestrictionHit[] {
  const ceil = bandCeilingFt(band);
  const hits: RestrictionHit[] = [];
  for (const r of rows) {
    if (r.quality === "rejected" || !overlaps(startMs, endMs, r.valid_from, r.valid_to)) continue;
    const area = (r.areas ?? []).find((a) =>
      (a.alt_low_ft ?? 0) <= ceil && (a.alt_high_ft == null || a.alt_high_ft >= 0) && pathIntersectsPolygon(path, a.points));
    if (!area) continue;
    hits.push({
      source: "faa-tfr", notam: r.external_id, name: r.name, type: r.restriction_type,
      valid_from: r.valid_from, valid_to: r.valid_to, alt_low_ft: area.alt_low_ft, alt_high_ft: area.alt_high_ft,
      geometry_approximated: (r.quality_flags ?? []).includes("arc_densified"), severity: "high",
    });
  }
  return hits;
}

// ─── Weather advisories ─────────────────────────────────────────────────────
export interface AdvisoryRow {
  id: number; kind: string; external_id: string; hazard: string | null; severity: string | null;
  valid_from: string; valid_to: string; alt_low_ft: number | null; alt_high_ft: number | null;
  geometry_type: string; polygon: LatLon[] | null; headline: string | null; quality: string;
}
export interface AdvisoryHit {
  source: string; kind: string; hazard: string | null; valid_from: string; valid_to: string;
  severity: "high" | "moderate" | "low"; headline: string | null; external_id: string;
}
const SEVERE = /CONVECTIVE|TS|TURB|ICE|LLWS|SFC_WND|Tornado|Thunderstorm|High Wind|Severe/i;

export function routeAdvisoryHits(path: LatLon[], startMs: number, endMs: number, band: string, rows: AdvisoryRow[]): AdvisoryHit[] {
  const ceil = bandCeilingFt(band);
  const out: AdvisoryHit[] = [];
  for (const a of rows) {
    if (a.quality === "rejected" || !overlaps(startMs, endMs, a.valid_from, a.valid_to)) continue;
    if (a.alt_low_ft != null && a.alt_low_ft > ceil) continue;            // entirely above the operating band
    if (a.geometry_type === "line") continue;                             // e.g. freezing-level contours
    const inside = a.geometry_type === "none"
      ? a.kind === "NWS_ALERT"                                            // zone alert issued for this point
      : !!a.polygon && pathIntersectsPolygon(path, a.polygon);
    if (!inside) continue;
    const sev: AdvisoryHit["severity"] = a.kind === "CONVECTIVE_SIGMET" || a.kind === "SIGMET" ? "high"
      : SEVERE.test(`${a.hazard ?? ""} ${a.headline ?? ""}`) ? "moderate" : "low";
    out.push({ source: a.kind === "NWS_ALERT" ? "nws-alerts" : "awc", kind: a.kind, hazard: a.hazard,
      valid_from: a.valid_from, valid_to: a.valid_to, severity: sev, headline: a.headline, external_id: a.external_id });
  }
  return out;
}

// ─── Live ADS-B ─────────────────────────────────────────────────────────────
export interface TrafficRow {
  icao24: string; callsign: string | null; observed_at: string; lat: number; lon: number;
  baro_alt_m: number | null; geo_alt_m: number | null; on_ground: boolean; velocity_ms: number | null;
  track_deg: number | null; quality: string;
}
export interface LiveTrafficHit {
  source: "opensky"; icao24: string; callsign: string | null; distance_m: number; altitude_m: number | null;
  age_s: number; severity: "high" | "moderate" | "low";
}
/** Aircraft currently near the route and low enough to matter. A live snapshot
 *  says nothing about later departures — callers pass `applicable` honestly. */
export function nearbyLiveTraffic(path: LatLon[], rows: TrafficRow[], nowMs: number,
  opts: { radiusM?: number; maxAltM?: number; maxAgeS?: number } = {}): LiveTrafficHit[] {
  const radius = opts.radiusM ?? 2000, maxAlt = opts.maxAltM ?? 900, maxAge = opts.maxAgeS ?? 120;
  const latest = new Map<string, TrafficRow>();
  for (const r of rows) {
    const prev = latest.get(r.icao24);
    if (!prev || Date.parse(r.observed_at) > Date.parse(prev.observed_at)) latest.set(r.icao24, r);
  }
  const out: LiveTrafficHit[] = [];
  for (const r of latest.values()) {
    if (r.quality === "rejected" || r.on_ground) continue;
    const age = (nowMs - Date.parse(r.observed_at)) / 1000;
    if (age > maxAge || age < -30) continue;
    const alt = r.geo_alt_m ?? r.baro_alt_m;
    if (alt != null && alt > maxAlt) continue;
    const d = distToPathM({ lat: r.lat, lon: r.lon }, path);
    if (d > radius) continue;
    out.push({ source: "opensky", icao24: r.icao24, callsign: r.callsign, distance_m: Math.round(d),
      altitude_m: alt != null ? Math.round(alt) : null, age_s: Math.round(age),
      severity: d < 500 ? "high" : d < 1200 ? "moderate" : "low" });
  }
  return out.sort((a, b) => a.distance_m - b.distance_m);
}

// ─── Forecast vs observation ────────────────────────────────────────────────
export interface MetarObs {
  station: string; obs_time: string; distance_km: number; age_minutes: number;
  wind_kt: number | null; gust_kt: number | null; visibility_sm: number | null; flight_category: string | null;
  quality: string; raw: string;
}
export interface CrossCheck {
  status: "agree" | "disagree" | "no_observation" | "not_applicable";
  reason: string;
  observation?: { station: string; obs_time: string; distance_km: number; age_minutes: number;
    wind_kmh: number | null; gust_kmh: number | null; visibility_sm: number | null; flight_category: string | null; raw: string };
  deltas?: { wind_kmh: number | null; gust_kmh: number | null };
}
/** Compare a forecast for ~now with the nearest METAR. Only meaningful when the
 *  forecast is for within the next hour; later departures → not_applicable. */
export function crossCheckForecast(
  fc: { windKmh: number; gustKmh: number; validAtMs: number }, obs: MetarObs | null, nowMs: number,
): CrossCheck {
  if (fc.validAtMs - nowMs > 60 * 60_000) return { status: "not_applicable", reason: "departure is more than 60 min ahead — no observation exists yet" };
  if (!obs || obs.quality === "rejected" || obs.wind_kt == null) return { status: "no_observation", reason: "no usable METAR within 30 km / 90 min" };
  const w = obs.wind_kt * 1.852, g = (obs.gust_kt ?? obs.wind_kt) * 1.852;
  const dw = fc.windKmh - w, dg = fc.gustKmh - g;
  const bad = Math.abs(dw) > Math.max(10, 0.4 * w) || Math.abs(dg) > Math.max(15, 0.4 * g);
  return {
    status: bad ? "disagree" : "agree",
    reason: bad
      ? `forecast ${Math.round(fc.windKmh)}/${Math.round(fc.gustKmh)} km/h vs observed ${Math.round(w)}/${Math.round(g)} km/h at ${obs.station}`
      : `forecast within tolerance of ${obs.station} observation`,
    observation: { station: obs.station, obs_time: obs.obs_time, distance_km: Math.round(obs.distance_km * 10) / 10,
      age_minutes: Math.round(obs.age_minutes), wind_kmh: Math.round(w * 10) / 10, gust_kmh: Math.round(g * 10) / 10,
      visibility_sm: obs.visibility_sm, flight_category: obs.flight_category, raw: obs.raw },
    deltas: { wind_kmh: Math.round(dw * 10) / 10, gust_kmh: Math.round(dg * 10) / 10 },
  };
}

/** Apply the promoted wind-bias correction (forecast − bias). Identity when
 *  the active model has never been trained (n_train = 0). */
export function applyWindBias(windKmh: number, gustKmh: number, model: { params?: { wind_bias_kmh?: number; gust_bias_kmh?: number }; n_train?: number } | null) {
  if (!model || !model.n_train) return { windKmh, gustKmh, applied: false };
  return {
    windKmh: Math.max(0, windKmh - Number(model.params?.wind_bias_kmh ?? 0)),
    gustKmh: Math.max(0, gustKmh - Number(model.params?.gust_bias_kmh ?? 0)),
    applied: true,
  };
}

/** Promoted duration calibration factor for a band (1 when untrained). */
export function durationFactor(model: { params?: { factor_by_band?: Record<string, number>; default_factor?: number }; n_train?: number } | null, band: string): number {
  if (!model || !model.n_train) return 1;
  const f = Number(model.params?.factor_by_band?.[band] ?? model.params?.default_factor ?? 1);
  return Number.isFinite(f) && f >= 0.7 && f <= 1.5 ? f : 1;
}
