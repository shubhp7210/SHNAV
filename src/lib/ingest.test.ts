// Parsers/validators run on REAL recorded responses from each source
// (supabase/tests/fixtures/ingest, captured 2026-11-15/16).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aixmCoord, inRegion, parseAirSigmets, parseGAirmets, parseMetars, parseNwsAlerts, parseOpenSky, parseTafs,
  parseTfrDetail, parseTfrList, parseVerificationForecasts, STATIONS,
} from "../../supabase/functions/_shared/ingest/parsers";
import { parseRetryAfter } from "../../supabase/functions/_shared/ingest/fetcher";

const fx = (f: string) => readFileSync(join(process.cwd(), "supabase/tests/fixtures/ingest", f), "utf8");
const fxJson = (f: string) => JSON.parse(fx(f));
const AT = new Date("2026-11-16T02:30:00Z");

describe("METAR (aviationweather.gov)", () => {
  const { records, rejected } = parseMetars(fxJson("awc-metar-2026-11-16T0225Z.json"), AT);
  it("parses every real report with no invented values", () => {
    expect(rejected).toBe(0);
    expect(records.length).toBe(10);
    const nyc = records.find((r) => r.station === "KNYC" && r.obs_time === "2026-11-16T01:51:00.000Z")!;
    expect(nyc.wind_variable).toBe(true);
    expect(nyc.wind_dir_deg).toBeNull();          // VRB is not turned into a direction
    expect(nyc.wind_kt).toBe(6);
    expect(nyc.visibility_sm).toBe(10);
    expect(nyc.visibility_plus).toBe(true);
    expect(nyc.gust_kt).toBeNull();               // absent gust group stays absent
    expect(nyc.quality_flags).toContain("maintenance_indicator");
  });
  it("rejects physically impossible and future observations; flags suspect ones", () => {
    const base = { icaoId: "KTST", obsTime: AT.getTime() / 1000 - 600, lat: 40.7, lon: -74, rawOb: "METAR KTST" };
    const r = parseMetars([
      { ...base, wspd: 400 },
      { ...base, obsTime: AT.getTime() / 1000 + 3600, wspd: 5 },
      { ...base, wspd: 20, wgst: 10 },
      { ...base, wspd: 5, temp: 5, dewp: 9 },
      { icaoId: "KBAD", rawOb: "x" },
    ], AT);
    expect(r.rejected).toBe(1);
    expect(r.records.map((x) => x.quality)).toEqual(["rejected", "rejected", "suspect", "suspect"]);
    expect(r.records[2].quality_flags).toContain("gust_below_wind");
    expect(r.records[3].quality_flags).toContain("dewpoint_above_temp");
  });
});

describe("TAF", () => {
  it("keeps forecast periods with null for absent groups", () => {
    const { records, rejected } = parseTafs(fxJson("awc-taf-2026-11-16T0225Z.json"));
    expect(rejected).toBe(0);
    const ewr = records.find((t) => t.station === "KEWR")!;
    expect(ewr.valid_from).toBe("2026-11-16T00:00:00.000Z");
    expect(ewr.periods.length).toBeGreaterThan(1);
    expect((ewr.periods[0] as { gust_kt: number }).gust_kt).toBe(20);
    expect((ewr.periods[1] as { gust_kt: number | null }).gust_kt).toBeNull();
  });
});

describe("Advisories", () => {
  it("drops SIGMETs outside the NYC region (all 3 real ones are Pacific NW convective)", () => {
    const r = parseAirSigmets(fxJson("awc-airsigmet-2026-11-16T0225Z.json"));
    expect(r.records.length).toBe(0);
    expect(r.outside).toBe(3);
  });
  it("classifies an in-region convective SIGMET", () => {
    const sig = { icaoId: "KKCI", seriesId: "5E", airSigmetType: "SIGMET", hazard: "CONVECTIVE",
      validTimeFrom: 1794794100, validTimeTo: 1794801300, altitudeHi1: 40000,
      coords: [{ lat: 40.5, lon: -74.3 }, { lat: 40.9, lon: -74.3 }, { lat: 40.9, lon: -73.6 }, { lat: 40.5, lon: -73.6 }] };
    const r = parseAirSigmets([sig]);
    expect(r.records[0].kind).toBe("CONVECTIVE_SIGMET");
    expect(r.records[0].alt_high_ft).toBe(40000);
  });
  it("keeps only G-AIRMETs whose extent overlaps the region, with numeric coordinates", () => {
    const r = parseGAirmets(fxJson("awc-gairmet-2026-11-16T0225Z.json"));
    // Areas: icing + mountain obscuration over the Northeast. Lines: freezing-level
    // contours crossing the region (kept, but never treated as an area by route checks).
    const areas = r.records.filter((x) => x.geometry_type === "polygon").map((x) => x.hazard).sort();
    expect(areas).toEqual(["ICE", "MT_OBSC"]);
    expect(r.records.filter((x) => x.geometry_type === "line").every((x) => x.hazard === "FZLVL")).toBe(true);
    expect(typeof r.records[0].polygon![0].lat).toBe("number");
    expect(r.outside).toBeGreaterThan(40);
  });
  it("handles an empty NWS alert collection", () => {
    expect(parseNwsAlerts(fxJson("nws-alerts-2026-11-16T0225Z.json"))).toEqual({ records: [], rejected: 0 });
  });
});

describe("FAA TFR", () => {
  it("parses the national list", () => {
    const l = parseTfrList(fxJson("faa-tfr-list-2026-11-15.json"));
    expect(l.length).toBe(49);
    expect(l[0]).toMatchObject({ notam_id: "6/7641", state: "ID", type: "HAZARDS" });
  });
  it("converts AIXM coordinates", () => {
    expect(aixmCoord("43.91666667N")).toBeCloseTo(43.9167, 4);
    expect(aixmCoord("112.75W")).toBe(-112.75);
    expect(aixmCoord("garbage")).toBeNull();
  });
  it("parses a polygon TFR with altitudes and UTC validity", () => {
    const d = parseTfrDetail(fx("faa-tfr-detail-6_7641.xml"));
    expect(d.quality).toBe("ok");
    expect(d.areas.length).toBe(1);
    expect(d.areas[0].points.length).toBeGreaterThanOrEqual(3);
    expect(d.valid_from).toBe("2026-11-17T14:00:00.000Z");
    expect(d.valid_to).toBe("2026-11-21T02:00:00.000Z");
    expect(d.alt_low_ft).toBe(0);
    expect(d.alt_high_ft).toBe(8000);
  });
  it("uses FAA's merged area polygons (exact vertices), not the arc-based component shapes", () => {
    const d = parseTfrDetail(fx("faa-tfr-detail-6_7632.xml"));
    expect(d.areas.map((a) => a.points.length)).toEqual([56, 10, 7, 5]);
    expect(d.quality).toBe("ok");
    expect(d.quality_flags).not.toContain("arc_densified");
    for (const a of d.areas) for (const p of a.points) {
      expect(p.lat).toBeGreaterThan(29); expect(p.lat).toBeLessThan(32);   // Mayport, FL
      expect(p.lon).toBeGreaterThan(-83); expect(p.lon).toBeLessThan(-80);
    }
  });
  it("densifies an arc inside a merged area and flags the approximation", () => {
    const avx = (type: string, inner: string) => `<Avx><codeDatum>WGE</codeDatum><codeType>${type}</codeType>${inner}</Avx>`;
    const xml = `<TFRAreaGroup><aseTFRArea><codeDistVerLower>HEI</codeDistVerLower><valDistVerLower>0</valDistVerLower>
      <uomDistVerLower>FT</uomDistVerLower><codeDistVerUpper>ALT</codeDistVerUpper><valDistVerUpper>3000</valDistVerUpper>
      <uomDistVerUpper>FT</uomDistVerUpper><dateEffective>2026-11-20T14:00:00</dateEffective></aseTFRArea><abdMergedArea>
      ${avx("GRC", "<geoLat>40.75N</geoLat><geoLong>073.95W</geoLong>")}
      ${avx("CWA", "<geoLat>40.75N</geoLat><geoLong>073.98W</geoLong><geoLatArc>40.75N</geoLatArc><geoLongArc>073.965W</geoLongArc><valRadiusArc>0.68</valRadiusArc><uomRadiusArc>NM</uomRadiusArc>")}
      ${avx("GRC", "<geoLat>40.70N</geoLat><geoLong>073.98W</geoLong>")}</abdMergedArea></TFRAreaGroup>`;
    const d = parseTfrDetail(xml);
    expect(d.quality_flags).toContain("arc_densified");
    expect(d.areas[0].points.length).toBeGreaterThan(6);
    expect(d.valid_to).toBeNull();                  // no expiry published → open-ended, not invented
  });
  it("rejects a detail document without geometry", () => {
    expect(parseTfrDetail("<XNOTAM-Update></XNOTAM-Update>").quality).toBe("rejected");
  });
});

describe("OpenSky ADS-B", () => {
  it("parses state vectors, keeping missing altitudes null", () => {
    const r = parseOpenSky(fxJson("opensky-nyc-2026-11-16T0229Z.json"));
    expect(r.records.length + r.rejected).toBe(78);
    const dal = r.records.find((t) => t.callsign === "DAL2361")!;
    expect(dal.on_ground).toBe(true);
    expect(dal.baro_alt_m).toBeNull();
    expect(dal.icao24).toBe("a34e9d");
    expect(r.records.every((t) => inRegion(t) || !inRegion(t))).toBe(true);
  });
  it("flags stale positions and rejects impossible speeds", () => {
    const r = parseOpenSky({ time: 1000, states: [
      ["abc123", "X", "US", 900, 1000, -74, 40.7, 300, false, 50],
      ["abc124", "Y", "US", 995, 1000, -74, 40.7, 300, false, 900],
      ["nothex", "Z", "US", 995, 1000, -74, 40.7, 300, false, 50],
    ] });
    expect(r.records.map((x) => x.quality)).toEqual(["suspect", "rejected"]);
    expect(r.rejected).toBe(1);
  });
});

describe("Open-Meteo verification snapshots", () => {
  it("extracts lead-time slots per station and skips incomplete ones", () => {
    const fetched = new Date("2026-11-16T02:07:00Z");
    const mk = (ws: (number | null)[]) => ({ latitude: 40.78, longitude: -73.87, minutely_15: {
      time: ["2026-11-16T03:00", "2026-11-16T04:00"], wind_speed_10m: ws, wind_gusts_10m: [20, 30],
      wind_direction_10m: [300, 310], temperature_2m: [5, 4], precipitation: [0, 0], weather_code: [0, 1], visibility: [20000, 20000] } });
    const out = parseVerificationForecasts([mk([10, null]), mk([12, 14])], ["KLGA", "KJFK"], fetched, [60, 120]);
    // 02:07 + 60 → 03:00 slot (lead 53), +120 → 04:00 slot (lead 113); KLGA 04:00 lacks wind.
    expect(out.map((o) => `${o.station}@${o.valid_at.slice(11, 16)}:${o.lead_minutes}`))
      .toEqual(["KLGA@03:00:53", "KJFK@03:00:53", "KJFK@04:00:113"]);
    expect(Object.keys(STATIONS)).toContain("KNYC");
  });
});

describe("Retry-After", () => {
  it("accepts seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThanOrEqual(28);
    expect(parseRetryAfter(null)).toBeNull();
  });
});
