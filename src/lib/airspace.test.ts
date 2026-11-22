import { describe, it, expect } from "vitest";
import {
  applyWindBias, crossCheckForecast, distToPathM, durationFactor, nearbyLiveTraffic, pathIntersectsPolygon,
  routeAdvisoryHits, routeRestrictionHits, type AdvisoryRow, type RestrictionRow, type TrafficRow,
} from "../../supabase/functions/_shared/airspace";
import { decide, type DecisionInputs } from "../../supabase/functions/_shared/decision";

// Downtown Manhattan Heliport → LaGuardia
const route = [{ lat: 40.7012, lon: -74.0091 }, { lat: 40.7769, lon: -73.874 }];
const box = (lat: number, lon: number, d = 0.01) =>
  [{ lat: lat - d, lon: lon - d }, { lat: lat - d, lon: lon + d }, { lat: lat + d, lon: lon + d }, { lat: lat + d, lon: lon - d }];
const T0 = Date.parse("2026-11-20T15:00:00Z"), T1 = T0 + 30 * 60_000;

const tfr = (over: Partial<RestrictionRow> = {}): RestrictionRow => ({
  id: 1, external_id: "6/1234", name: "VIP MOVEMENT", restriction_type: "VIP",
  valid_from: "2026-11-20T14:00:00Z", valid_to: "2026-11-20T18:00:00Z", alt_low_ft: 0, alt_high_ft: 3000,
  areas: [{ alt_low_ft: 0, alt_high_ft: 3000, points: box(40.739, -73.94) }],
  quality: "ok", quality_flags: [], fetched_at: "2026-11-20T13:00:00Z", ...over,
});

describe("geometry", () => {
  it("detects a route crossing a polygon even when no vertex is inside", () => {
    expect(pathIntersectsPolygon(route, box(40.739, -73.94))).toBe(true);
    expect(pathIntersectsPolygon(route, box(40.6, -74.2))).toBe(false);
  });
  it("measures distance to the route", () => {
    expect(distToPathM({ lat: 40.739, lon: -73.94 }, route)).toBeLessThan(600);
    expect(distToPathM({ lat: 40.80, lon: -74.05 }, route)).toBeGreaterThan(5000);
  });
});

describe("TFR checks", () => {
  it("hits an active TFR on the route below the band ceiling", () => {
    const h = routeRestrictionHits(route, T0, T1, "low", [tfr()]);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ notam: "6/1234", severity: "high" });
  });
  it("ignores TFRs outside the time window, above the band, or rejected", () => {
    expect(routeRestrictionHits(route, T0, T1, "low", [tfr({ valid_from: "2026-11-20T16:00:00Z" })])).toHaveLength(0);
    expect(routeRestrictionHits(route, T0, T1, "high", [tfr({ areas: [{ alt_low_ft: 3000, alt_high_ft: 18000, points: box(40.739, -73.94) }] })])).toHaveLength(0);
    expect(routeRestrictionHits(route, T0, T1, "low", [tfr({ quality: "rejected" })])).toHaveLength(0);
  });
  it("treats an open-ended TFR (no expiry) as active", () => {
    expect(routeRestrictionHits(route, T0, T1, "low", [tfr({ valid_to: null })])).toHaveLength(1);
  });
});

describe("advisory checks", () => {
  const adv = (over: Partial<AdvisoryRow>): AdvisoryRow => ({
    id: 1, kind: "CONVECTIVE_SIGMET", external_id: "x", hazard: "CONVECTIVE", severity: null,
    valid_from: "2026-11-20T14:00:00Z", valid_to: "2026-11-20T17:00:00Z", alt_low_ft: null, alt_high_ft: 40000,
    geometry_type: "polygon", polygon: box(40.74, -73.94, 0.05), headline: null, quality: "ok", ...over,
  });
  it("rates convective SIGMETs high and icing AIRMETs moderate; skips lines and high-floor areas", () => {
    expect(routeAdvisoryHits(route, T0, T1, "low", [adv({})])[0].severity).toBe("high");
    expect(routeAdvisoryHits(route, T0, T1, "low", [adv({ kind: "G-AIRMET", hazard: "ICE" })])[0].severity).toBe("moderate");
    expect(routeAdvisoryHits(route, T0, T1, "low", [adv({ geometry_type: "line" })])).toHaveLength(0);
    expect(routeAdvisoryHits(route, T0, T1, "low", [adv({ alt_low_ft: 8000 })])).toHaveLength(0);
  });
});

describe("live ADS-B", () => {
  const now = Date.parse("2026-11-20T15:00:00Z");
  const t = (over: Partial<TrafficRow>): TrafficRow => ({
    icao24: "abc123", callsign: "N123HX", observed_at: "2026-11-20T14:59:30Z", lat: 40.739, lon: -73.94,
    baro_alt_m: 300, geo_alt_m: null, on_ground: false, velocity_ms: 50, track_deg: 90, quality: "ok", ...over,
  });
  it("reports low aircraft near the route, newest fix per aircraft", () => {
    const hits = nearbyLiveTraffic(route, [t({}), t({ observed_at: "2026-11-20T14:58:00Z", lat: 41 })], now);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("high");
  });
  it("ignores high, grounded, stale or distant aircraft", () => {
    expect(nearbyLiveTraffic(route, [
      t({ icao24: "a1", baro_alt_m: 3000 }), t({ icao24: "a2", on_ground: true }),
      t({ icao24: "a3", observed_at: "2026-11-20T14:50:00Z" }), t({ icao24: "a4", lat: 40.9 }),
    ], now)).toHaveLength(0);
  });
});

describe("forecast vs observation", () => {
  const obs = { station: "KLGA", obs_time: "2026-11-20T14:51:00Z", distance_km: 3, age_minutes: 9, wind_kt: 10,
    gust_kt: null, visibility_sm: 10, flight_category: "VFR", quality: "ok", raw: "METAR KLGA" };
  const now = Date.parse("2026-11-20T15:00:00Z");
  it("agrees within tolerance, disagrees beyond it", () => {
    expect(crossCheckForecast({ windKmh: 20, gustKmh: 25, validAtMs: now }, obs, now).status).toBe("agree");
    const d = crossCheckForecast({ windKmh: 50, gustKmh: 70, validAtMs: now }, obs, now);
    expect(d.status).toBe("disagree");
    expect(d.deltas!.wind_kmh).toBeCloseTo(31.5, 0);
  });
  it("never compares a far-future forecast with a current observation", () => {
    expect(crossCheckForecast({ windKmh: 50, gustKmh: 70, validAtMs: now + 3 * 3600e3 }, obs, now).status).toBe("not_applicable");
    expect(crossCheckForecast({ windKmh: 50, gustKmh: 70, validAtMs: now }, null, now).status).toBe("no_observation");
  });
});

describe("promoted model application", () => {
  it("is the identity until a model has actually been trained", () => {
    expect(applyWindBias(30, 40, { params: { wind_bias_kmh: 8 }, n_train: 0 })).toEqual({ windKmh: 30, gustKmh: 40, applied: false });
    expect(applyWindBias(30, 40, { params: { wind_bias_kmh: 8, gust_bias_kmh: 5 }, n_train: 200 })).toEqual({ windKmh: 22, gustKmh: 35, applied: true });
    expect(durationFactor({ params: { factor_by_band: { low: 1.2 } }, n_train: 0 }, "low")).toBe(1);
    expect(durationFactor({ params: { factor_by_band: { low: 1.2 } }, n_train: 12 }, "low")).toBe(1.2);
    expect(durationFactor({ params: { default_factor: 9 }, n_train: 12 }, "mid")).toBe(1);   // out-of-range → ignored
  });
});

describe("decision with real external data", () => {
  const base: DecisionInputs = {
    trajectoryScore: 90, conflicts: 0, conflictCheck: "checked_clear",
    weather: { available: true, riskScore: 10, forecast15: 10, forecast30: 10, trend: "stable" },
    airspace: { allocated: true, delayMinutes: 0, loadPct: 20 }, vertiport: { checked: true, reserved: true, delayMinutes: 0 },
    route: { primaryId: "direct", primaryScore: 90, alternates: [{ id: "north", label: "North arc" }] },
    departureStart: new Date("2026-11-20T15:00:00Z"),
    external: { restrictions: { names: [], until: null }, clearAlternate: null, advisories: { high: [], moderate: [] },
      liveTraffic: { applicable: false, close: 0 }, dataStatus: { ok: true, problems: [] } },
  };
  it("reroutes around a TFR when a clear alternate exists, otherwise holds until it expires", () => {
    const r = decide({ ...base, external: { ...base.external!, restrictions: { names: ["6/1234 VIP"], until: "2026-11-20T16:30:00Z" },
      clearAlternate: { id: "north", label: "North arc" } } });
    expect(r.decision).toBe("REROUTE");
    expect(r.routeCandidateId).toBe("north");
    const h = decide({ ...base, external: { ...base.external!, restrictions: { names: ["6/1234 VIP"], until: "2026-11-20T16:30:00Z" } } });
    expect(h.decision).toBe("DELAY");
    expect(h.delayMinutes).toBe(90);
  });
  it("never issues GO into a convective SIGMET", () => {
    const r = decide({ ...base, external: { ...base.external!, advisories: { high: ["CONVECTIVE_SIGMET"], moderate: [] } } });
    expect(r.decision).not.toBe("GO");
  });
  it("states degraded data and confirmed user guidance instead of hiding them", () => {
    const r = decide({ ...base, external: { ...base.external!, dataStatus: { ok: false, problems: ["FAA TFR: stale"] } },
      userGuidance: ["You confirmed you often take off after the filed window."] });
    expect(r.decision).toBe("GO");
    expect(r.reason).toMatch(/FAA TFR: stale/);
    expect(r.reason).toMatch(/take off after the filed window/);
    const clean = decide(base);
    expect(r.confidence).toBe(clean.confidence - 5);   // only the stated data penalty — guidance never moves confidence
  });
  it("says so when external data was not checked at all", () => {
    const r = decide({ ...base, external: null });
    expect(r.reason).toMatch(/not checked/);
  });
});
