// Pure parsers + validators for every external aviation data source.
// No I/O here — the data-ingest edge function fetches, these turn responses
// into validated records, and vitest/Deno tests run them on recorded real
// responses (supabase/tests/fixtures/ingest/).
//
// Validation policy: a record is
//   - "rejected" when it is physically impossible or unusable (never used),
//   - "suspect"  when it is plausible but questionable (shown, flagged, not learned from),
//   - "ok"       otherwise.
// Missing values stay null — nothing is filled in.

export type Quality = "ok" | "suspect" | "rejected";
export interface LatLon { lat: number; lon: number }

/** NYC metro + approaches. Advisories/TFRs outside this box are not stored. */
export const REGION = { latMin: 39.5, latMax: 42.0, lonMin: -75.8, lonMax: -71.5 };
/** Stations used for METAR/TAF and forecast verification. */
export const STATIONS: Record<string, LatLon> = {
  KJFK: { lat: 40.6392, lon: -73.7639 },
  KLGA: { lat: 40.7769, lon: -73.874 },
  KEWR: { lat: 40.6828, lon: -74.1692 },
  KTEB: { lat: 40.8501, lon: -74.0608 },
  KNYC: { lat: 40.779, lon: -73.9692 },
  KHPN: { lat: 41.0670, lon: -73.7076 },
  KFRG: { lat: 40.7288, lon: -73.4134 },
};

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const epochToIso = (v: unknown): string | null => {
  const n = num(v);
  return n == null ? null : new Date(n * 1000).toISOString();
};
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function inRegion(p: LatLon): boolean {
  return p.lat >= REGION.latMin && p.lat <= REGION.latMax && p.lon >= REGION.lonMin && p.lon <= REGION.lonMax;
}
/** Bounding-box overlap of a point set with REGION (cheap pre-filter). */
export function touchesRegion(points: LatLon[]): boolean {
  if (!points.length) return false;
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of points) { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lon); d = Math.max(d, p.lon); }
  return !(b < REGION.latMin || a > REGION.latMax || d < REGION.lonMin || c > REGION.lonMax);
}

// ─── METAR ──────────────────────────────────────────────────────────────────
export interface MetarRecord {
  station: string; obs_time: string; report_time: string | null; receipt_time: string | null;
  lat: number; lon: number; wind_dir_deg: number | null; wind_variable: boolean;
  wind_kt: number | null; gust_kt: number | null; visibility_sm: number | null; visibility_plus: boolean;
  temp_c: number | null; dewpoint_c: number | null; altimeter_hpa: number | null;
  flight_category: string | null; wx_string: string | null; cover: string | null; raw: string;
  quality: Quality; quality_flags: string[];
}

export function parseMetars(json: unknown, now = new Date()): { records: MetarRecord[]; rejected: number } {
  const out: MetarRecord[] = [];
  let rejected = 0;
  if (!Array.isArray(json)) return { records: out, rejected: 0 };
  for (const m of json as Record<string, unknown>[]) {
    const flags: string[] = [];
    let quality: Quality = "ok";
    const obs = epochToIso(m.obsTime);
    const lat = num(m.lat), lon = num(m.lon);
    const raw = typeof m.rawOb === "string" ? m.rawOb : null;
    if (!obs || lat == null || lon == null || !raw || typeof m.icaoId !== "string") { rejected++; continue; }
    const variable = m.wdir === "VRB";
    const wdir = variable ? null : num(m.wdir);
    const wspd = num(m.wspd), wgst = num(m.wgst), temp = num(m.temp), dewp = num(m.dewp);
    const visRaw = m.visib;
    const visPlus = typeof visRaw === "string" && visRaw.endsWith("+");
    const vis = num(typeof visRaw === "string" ? visRaw.replace("+", "") : visRaw);

    if (Date.parse(obs) > now.getTime() + 10 * 60_000) { flags.push("future_observation"); quality = "rejected"; }
    if (wspd != null && (wspd < 0 || wspd > 200)) { flags.push("wind_out_of_range"); quality = "rejected"; }
    if (wdir != null && (wdir < 0 || wdir > 360)) { flags.push("wind_dir_out_of_range"); quality = "rejected"; }
    if (temp != null && (temp < -70 || temp > 60)) { flags.push("temp_out_of_range"); quality = "rejected"; }
    if (quality !== "rejected") {
      if (wgst != null && wspd != null && wgst < wspd) { flags.push("gust_below_wind"); quality = "suspect"; }
      if (temp != null && dewp != null && dewp > temp + 1) { flags.push("dewpoint_above_temp"); quality = "suspect"; }
      if (wspd == null) { flags.push("no_wind"); quality = "suspect"; }
      if (now.getTime() - Date.parse(obs) > 3 * 3_600_000) { flags.push("older_than_3h"); quality = "suspect"; }
      if (/\bAUTO\b/.test(raw) && /\$\s*$/.test(raw)) flags.push("maintenance_indicator");
    }
    out.push({
      station: m.icaoId as string, obs_time: obs, report_time: isoOrNull(m.reportTime), receipt_time: isoOrNull(m.receiptTime),
      lat, lon, wind_dir_deg: wdir, wind_variable: variable, wind_kt: wspd, gust_kt: wgst,
      visibility_sm: vis, visibility_plus: visPlus, temp_c: temp, dewpoint_c: dewp, altimeter_hpa: num(m.altim),
      flight_category: typeof m.fltCat === "string" ? m.fltCat : null,
      wx_string: typeof m.wxString === "string" ? m.wxString : null,
      cover: typeof m.cover === "string" ? m.cover : null, raw, quality, quality_flags: flags,
    });
  }
  return { records: out, rejected };
}

// ─── TAF ────────────────────────────────────────────────────────────────────
export interface TafRecord {
  station: string; issue_time: string; valid_from: string; valid_to: string; lat: number | null; lon: number | null;
  periods: unknown[]; raw: string; quality: Quality; quality_flags: string[];
}
export function parseTafs(json: unknown): { records: TafRecord[]; rejected: number } {
  const out: TafRecord[] = [];
  let rejected = 0;
  if (!Array.isArray(json)) return { records: out, rejected: 0 };
  for (const t of json as Record<string, unknown>[]) {
    const issue = isoOrNull(t.issueTime), from = epochToIso(t.validTimeFrom), to = epochToIso(t.validTimeTo);
    if (typeof t.icaoId !== "string" || !issue || !from || !to || typeof t.rawTAF !== "string") { rejected++; continue; }
    const flags: string[] = [];
    let quality: Quality = "ok";
    if (Date.parse(to) <= Date.parse(from)) { flags.push("valid_to_before_from"); quality = "rejected"; }
    const periods = Array.isArray(t.fcsts) ? (t.fcsts as Record<string, unknown>[]).map((f) => ({
      from: epochToIso(f.timeFrom), to: epochToIso(f.timeTo), change: f.fcstChange ?? null, probability: num(f.probability),
      wind_dir_deg: num(f.wdir), wind_kt: num(f.wspd), gust_kt: num(f.wgst), visibility: f.visib ?? null,
      wx: f.wxString ?? null, clouds: f.clouds ?? [],
    })) : [];
    out.push({ station: t.icaoId, issue_time: issue, valid_from: from, valid_to: to, lat: num(t.lat), lon: num(t.lon),
      periods, raw: t.rawTAF, quality, quality_flags: flags });
  }
  return { records: out, rejected };
}

// ─── Advisories (SIGMET / AIRMET / G-AIRMET / NWS) ──────────────────────────
export interface AdvisoryRecord {
  kind: "SIGMET" | "CONVECTIVE_SIGMET" | "AIRMET" | "G-AIRMET" | "NWS_ALERT" | "OTHER";
  external_id: string; hazard: string | null; severity: string | null;
  valid_from: string; valid_to: string; alt_low_ft: number | null; alt_high_ft: number | null;
  geometry_type: "polygon" | "line" | "none"; polygon: LatLon[] | null; headline: string | null; raw: string | null;
  quality: Quality; quality_flags: string[];
}

const coordsOf = (v: unknown): LatLon[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[])
    .map((c) => ({ lat: num(c.lat), lon: num(c.lon) }))
    .filter((c): c is LatLon => c.lat != null && c.lon != null) : [];

/** AWC airsigmet: US SIGMETs, convective SIGMETs and AIRMETs. Region-filtered. */
export function parseAirSigmets(json: unknown): { records: AdvisoryRecord[]; rejected: number; outside: number } {
  const out: AdvisoryRecord[] = [];
  let rejected = 0, outside = 0;
  if (!Array.isArray(json)) return { records: out, rejected, outside };
  for (const a of json as Record<string, unknown>[]) {
    const from = epochToIso(a.validTimeFrom), to = epochToIso(a.validTimeTo);
    const poly = coordsOf(a.coords);
    if (!from || !to || poly.length < 3) { rejected++; continue; }
    if (!touchesRegion(poly)) { outside++; continue; }
    const t = String(a.airSigmetType ?? "").toUpperCase();
    const hazard = typeof a.hazard === "string" ? a.hazard : null;
    const kind: AdvisoryRecord["kind"] = t === "AIRMET" ? "AIRMET"
      : hazard === "CONVECTIVE" ? "CONVECTIVE_SIGMET" : t === "SIGMET" ? "SIGMET" : "OTHER";
    out.push({
      kind, external_id: `${a.icaoId ?? "?"}-${a.seriesId ?? a.alphaChar ?? "?"}-${a.validTimeFrom}`,
      hazard, severity: a.severity != null ? String(a.severity) : null, valid_from: from, valid_to: to,
      alt_low_ft: num(a.altitudeLow1), alt_high_ft: num(a.altitudeHi1) ?? num(a.altitudeHi2),
      geometry_type: "polygon", polygon: poly, headline: null,
      raw: typeof a.rawAirSigmet === "string" ? a.rawAirSigmet : null,
      quality: Date.parse(to) <= Date.parse(from) ? "rejected" : "ok",
      quality_flags: Date.parse(to) <= Date.parse(from) ? ["valid_to_before_from"] : [],
    });
  }
  return { records: out, rejected, outside };
}

/** G-AIRMET levels ("040", "SFC", "FZL") → feet. */
const levelFt = (v: unknown): number | null => {
  if (v == null) return null;
  const s = String(v).toUpperCase();
  if (s === "SFC") return 0;
  const n = num(s);
  return n == null ? null : n * 100;
};

export function parseGAirmets(json: unknown): { records: AdvisoryRecord[]; rejected: number; outside: number } {
  const out: AdvisoryRecord[] = [];
  let rejected = 0, outside = 0;
  if (!Array.isArray(json)) return { records: out, rejected, outside };
  for (const g of json as Record<string, unknown>[]) {
    const valid = isoOrNull(g.validTime);
    const pts = coordsOf(g.coords);
    if (!valid || pts.length < 2) { rejected++; continue; }
    if (!touchesRegion(pts)) { outside++; continue; }
    const isLine = String(g.geometryType ?? g.geom ?? "").toUpperCase() === "LINE";
    // A G-AIRMET snapshot is valid for its forecast hour ±90 min (3-hourly issuance).
    const from = new Date(Date.parse(valid) - 90 * 60_000).toISOString();
    const to = new Date(Date.parse(valid) + 90 * 60_000).toISOString();
    out.push({
      kind: "G-AIRMET", external_id: `${g.tag ?? "?"}-${g.hazard ?? "?"}-${g.validTime}-${g.issueTime ?? ""}`,
      hazard: typeof g.hazard === "string" ? g.hazard : null, severity: g.severity != null ? String(g.severity) : null,
      valid_from: from, valid_to: to,
      alt_low_ft: levelFt(g.base ?? g.fzlbase), alt_high_ft: levelFt(g.top ?? g.fzltop ?? g.level),
      geometry_type: isLine ? "line" : "polygon", polygon: pts, headline: g.due_to != null ? String(g.due_to) : null,
      raw: null, quality: "ok", quality_flags: [],
    });
  }
  return { records: out, rejected, outside };
}

/** api.weather.gov alerts (GeoJSON FeatureCollection). Zone-based alerts have no geometry. */
export function parseNwsAlerts(json: unknown): { records: AdvisoryRecord[]; rejected: number } {
  const out: AdvisoryRecord[] = [];
  let rejected = 0;
  const feats = (json as { features?: unknown[] })?.features;
  if (!Array.isArray(feats)) return { records: out, rejected };
  for (const f of feats as Record<string, unknown>[]) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const from = isoOrNull(p.onset) ?? isoOrNull(p.effective);
    const to = isoOrNull(p.ends) ?? isoOrNull(p.expires);
    if (typeof p.id !== "string" || !from || !to) { rejected++; continue; }
    let poly: LatLon[] | null = null;
    const geom = f.geometry as { type?: string; coordinates?: number[][][] } | null;
    if (geom?.type === "Polygon" && Array.isArray(geom.coordinates?.[0])) {
      poly = geom.coordinates![0].map(([lon, lat]) => ({ lat, lon }));
    }
    out.push({
      kind: "NWS_ALERT", external_id: p.id, hazard: typeof p.event === "string" ? p.event : null,
      severity: typeof p.severity === "string" ? p.severity : null, valid_from: from, valid_to: to,
      alt_low_ft: null, alt_high_ft: null, geometry_type: poly ? "polygon" : "none", polygon: poly,
      headline: typeof p.headline === "string" ? p.headline : null,
      raw: typeof p.description === "string" ? p.description.slice(0, 4000) : null,
      quality: "ok", quality_flags: poly ? [] : ["zone_based_no_geometry"],
    });
  }
  return { records: out, rejected };
}

// ─── FAA TFR ────────────────────────────────────────────────────────────────
export interface TfrListItem { notam_id: string; type: string | null; state: string | null; facility: string | null; description: string | null }
export function parseTfrList(json: unknown): TfrListItem[] {
  if (!Array.isArray(json)) return [];
  return (json as Record<string, unknown>[])
    .filter((t) => typeof t.notam_id === "string" && /^\d\/\d+$/.test(t.notam_id as string))
    .map((t) => ({
      notam_id: t.notam_id as string, type: (t.type as string) ?? null, state: (t.state as string) ?? null,
      facility: (t.facility as string) ?? null, description: (t.description as string) ?? null,
    }));
}

export interface TfrArea { alt_low_ft: number | null; alt_high_ft: number | null; points: LatLon[] }
export interface TfrDetail {
  name: string | null; city: string | null; valid_from: string | null; valid_to: string | null;
  alt_low_ft: number | null; alt_high_ft: number | null; areas: TfrArea[]; description: string | null;
  quality: Quality; quality_flags: string[];
}

/** "40.12345N" / "073.98W" → signed degrees. */
export function aixmCoord(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)([NSEW])$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] === "S" || m[2] === "W" ? -v : v;
}
const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};
const tags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
/** Vertical limit in feet; HEI (AGL) and ALT (MSL) are both feet; STD is a flight level. */
const vertFt = (code: string | null, val: string | null, uom: string | null): number | null => {
  const n = num(val);
  if (n == null) return null;
  if (code === "STD" || uom === "FL") return n * 100;
  if (uom === "M") return Math.round(n * 3.28084);
  return n;
};
const NM_M = 1852;
function destination(c: LatLon, bearingDeg: number, distM: number): LatLon {
  const R = 6_371_000, br = (bearingDeg * Math.PI) / 180, d = distM / R;
  const la1 = (c.lat * Math.PI) / 180, lo1 = (c.lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (lo2 * 180) / Math.PI };
}
function bearing(a: LatLon, b: LatLon): number {
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180, dl = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
/** 36-gon circle. */
export function circle(c: LatLon, radiusM: number, n = 36): LatLon[] {
  return Array.from({ length: n + 1 }, (_, i) => destination(c, (360 * i) / n, radiusM));
}

/** Parse an FAA XNOTAM detail document (AIXM 4.5-style). Arcs are densified. */
export function parseTfrDetail(xml: string): TfrDetail {
  const flags: string[] = [];
  let quality: Quality = "ok";
  const areas: TfrArea[] = [];
  const froms: string[] = [], tos: string[] = [];
  for (const group of tags(xml, "TFRAreaGroup")) {
    const ase = tags(group, "aseTFRArea")[0] ?? group;
    const low = vertFt(tag(ase, "codeDistVerLower"), tag(ase, "valDistVerLower"), tag(ase, "uomDistVerLower"));
    const high = vertFt(tag(ase, "codeDistVerUpper"), tag(ase, "valDistVerUpper"), tag(ase, "uomDistVerUpper"));
    const eff = tag(ase, "dateEffective"), exp = tag(ase, "dateExpire");
    if (eff) froms.push(eff);
    if (exp) tos.push(exp);
    for (const merged of tags(group, "abdMergedArea")) {
      const pts: LatLon[] = [];
      const avxs = tags(merged, "Avx");
      for (let i = 0; i < avxs.length; i++) {
        const a = avxs[i];
        // Only the vertex's own coordinates (Frd/fix references nest their own geoLat).
        const own = a.replace(/<Frd>[\s\S]*?<\/Frd>/g, "");
        const type = tag(own, "codeType");
        const lat = aixmCoord(tag(own, "geoLat")), lon = aixmCoord(tag(own, "geoLong"));
        if (type === "GRC" || type === "RHL") {
          if (lat != null && lon != null) pts.push({ lat, lon });
        } else if (type === "CWA" || type === "CCA" || type === "CIR") {
          const c = { lat: aixmCoord(tag(own, "geoLatArc")), lon: aixmCoord(tag(own, "geoLongArc")) };
          const r = num(tag(own, "valRadiusArc"));
          const uom = tag(own, "uomRadiusArc") ?? "NM";
          if (c.lat == null || c.lon == null || r == null) { flags.push("arc_missing_center"); quality = "suspect"; continue; }
          const center = { lat: c.lat, lon: c.lon };
          const rM = uom === "KM" ? r * 1000 : uom === "M" ? r : r * NM_M;
          const start = lat != null && lon != null ? { lat, lon } : pts[pts.length - 1];
          // Arc ends at the next vertex's own position (if any).
          const nextOwn = avxs[i + 1]?.replace(/<Frd>[\s\S]*?<\/Frd>/g, "");
          const nLat = nextOwn ? aixmCoord(tag(nextOwn, "geoLat")) : null;
          const nLon = nextOwn ? aixmCoord(tag(nextOwn, "geoLong")) : null;
          const end = nLat != null && nLon != null ? { lat: nLat, lon: nLon } : pts[0];
          if (type === "CIR" || !start || !end || avxs.length === 1) {
            pts.push(...circle(center, rM));
          } else {
            const b0 = bearing(center, start), b1 = bearing(center, end);
            const cw = type === "CWA";
            let sweep = cw ? (b1 - b0 + 360) % 360 : -((b0 - b1 + 360) % 360);
            if (sweep === 0) sweep = cw ? 360 : -360;
            const steps = Math.max(4, Math.ceil(Math.abs(sweep) / 10));
            for (let k = 0; k <= steps; k++) pts.push(destination(center, b0 + (sweep * k) / steps, rM));
            flags.push("arc_densified");
          }
        }
      }
      if (pts.length >= 3) areas.push({ alt_low_ft: low, alt_high_ft: high, points: pts });
      else { flags.push("area_without_geometry"); quality = "suspect"; }
    }
  }
  if (!areas.length) { flags.push("no_geometry"); quality = "rejected"; }
  const toIso = (s: string) => isoOrNull(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  const fromIso = froms.map(toIso).filter(Boolean).sort()[0] ?? null;
  const toIsoV = tos.map(toIso).filter(Boolean).sort().slice(-1)[0] ?? null;
  const lows = areas.map((a) => a.alt_low_ft).filter((v): v is number => v != null);
  const highs = areas.map((a) => a.alt_high_ft).filter((v): v is number => v != null);
  return {
    name: tag(xml, "txtLocalName"), city: tag(xml, "txtNameCity"),
    valid_from: fromIso, valid_to: toIsoV,
    alt_low_ft: lows.length ? Math.min(...lows) : null, alt_high_ft: highs.length ? Math.max(...highs) : null,
    areas, description: tag(xml, "txtDescrUSNS"),
    quality, quality_flags: [...new Set(flags)],
  };
}

// ─── OpenSky ADS-B ──────────────────────────────────────────────────────────
export interface TrafficRecord {
  icao24: string; callsign: string | null; origin_country: string | null; observed_at: string;
  lat: number; lon: number; baro_alt_m: number | null; geo_alt_m: number | null; on_ground: boolean;
  velocity_ms: number | null; track_deg: number | null; vertical_rate_ms: number | null; squawk: string | null;
  category: number | null; quality: Quality; quality_flags: string[];
}
export function parseOpenSky(json: unknown): { records: TrafficRecord[]; rejected: number; time: string | null } {
  const j = json as { time?: number; states?: unknown[][] | null };
  const out: TrafficRecord[] = [];
  let rejected = 0;
  const snap = num(j?.time);
  for (const s of j?.states ?? []) {
    const lon = num(s[5]), lat = num(s[6]), tPos = num(s[3]), tLast = num(s[4]);
    const icao = typeof s[0] === "string" ? s[0].trim().toLowerCase() : "";
    if (!/^[0-9a-f]{6}$/.test(icao) || lat == null || lon == null || (tPos ?? tLast) == null) { rejected++; continue; }
    const flags: string[] = [];
    let quality: Quality = "ok";
    if (snap != null && tPos != null && snap - tPos > 60) { flags.push("position_older_than_60s"); quality = "suspect"; }
    const vel = num(s[9]);
    if (vel != null && vel > 350) { flags.push("velocity_out_of_range"); quality = "rejected"; }
    out.push({
      icao24: icao, callsign: typeof s[1] === "string" ? s[1].trim() || null : null,
      origin_country: typeof s[2] === "string" ? s[2] : null,
      observed_at: new Date((tPos ?? tLast)! * 1000).toISOString(), lat, lon,
      baro_alt_m: num(s[7]), geo_alt_m: num(s[13]), on_ground: s[8] === true, velocity_ms: vel,
      track_deg: num(s[10]), vertical_rate_ms: num(s[11]), squawk: typeof s[14] === "string" ? s[14] : null,
      category: num(s[17]), quality, quality_flags: flags,
    });
  }
  return { records: out, rejected, time: snap != null ? new Date(snap * 1000).toISOString() : null };
}

// ─── Open-Meteo multi-location (verification snapshots) ─────────────────────
export interface ForecastSnapshot {
  station: string; lat: number; lon: number; valid_at: string; lead_minutes: number;
  wind_kmh: number; wind_dir_deg: number | null; gust_kmh: number; precip_mm: number | null;
  temp_c: number | null; weather_code: number | null; visibility_m: number | null;
}
/** Open-Meteo returns one object per location (array when >1 location). */
export function parseVerificationForecasts(json: unknown, stations: string[], fetchedAt: Date, leadsMin: number[]): ForecastSnapshot[] {
  const arr = Array.isArray(json) ? json : [json];
  const out: ForecastSnapshot[] = [];
  arr.forEach((loc: Record<string, unknown>, idx) => {
    const st = stations[idx];
    const m = loc?.minutely_15 as Record<string, unknown[]> | undefined;
    if (!st || !m || !Array.isArray(m.time)) return;
    const lat = num(loc.latitude) ?? STATIONS[st]?.lat, lon = num(loc.longitude) ?? STATIONS[st]?.lon;
    if (lat == null || lon == null) return;
    for (const lead of leadsMin) {
      const target = Math.floor((fetchedAt.getTime() + lead * 60_000) / 900_000) * 900_000;
      const i = (m.time as string[]).findIndex((t) => Date.parse(`${t}Z`.replace(/Z+$/, "Z")) === target);
      if (i < 0) continue;
      const v = (k: string) => num((m[k] as unknown[] | undefined)?.[i]);
      const ws = v("wind_speed_10m"), wg = v("wind_gusts_10m");
      if (ws == null || wg == null) continue;
      out.push({
        station: st, lat, lon, valid_at: new Date(target).toISOString(),
        lead_minutes: Math.round((target - fetchedAt.getTime()) / 60_000),
        wind_kmh: ws, wind_dir_deg: v("wind_direction_10m"), gust_kmh: wg, precip_mm: v("precipitation"),
        temp_c: v("temperature_2m"), weather_code: v("weather_code"), visibility_m: v("visibility"),
      });
    }
  });
  return out;
}
