// Unit tests for the pure Step 2 backend logic shared by the edge functions.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseDepartureWindow, epochMinutes } from "../../supabase/functions/_shared/departure";
import { nearestVertiport } from "../../supabase/functions/_shared/vertiport";
import { trafficLabel } from "../../supabase/functions/_shared/anonymize";
import { parseMinutely, pointAt, slot15, forecastUrl } from "../../supabase/functions/_shared/forecast";
import { decide, type DecisionInputs } from "../../supabase/functions/_shared/decision";
import { checkNetwork, type FlightTrack } from "../../supabase/functions/_shared/conflicts";
import { resolveLocal } from "../../supabase/functions/_shared/geocode";

const NOW = new Date("2026-11-02T20:00:00Z");

describe("departure window", () => {
  it("accepts an absolute window with an offset and rejects offset-less strings", () => {
    const ok = parseDepartureWindow("2026-11-02T15:30:00-05:00", "2026-11-02T15:40:00-05:00", NOW);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.window.start.toISOString()).toBe("2026-11-02T20:30:00.000Z");
    // The old payload: local wall time with no offset (was read as UTC → 5 h error).
    const bad = parseDepartureWindow("2026-11-02T15:30:00", "2026-11-02T15:40:00", NOW);
    expect(bad.ok).toBe(false);
  });
  it("enforces order, the 10-minute limit, past and horizon bounds", () => {
    const err = (s: string, e: string) => { const r = parseDepartureWindow(s, e, NOW); return "errors" in r ? r.errors : []; };
    expect(err("2026-11-02T21:00:00Z", "2026-11-02T20:59:00Z").join()).toMatch(/after/);
    expect(err("2026-11-02T21:00:00Z", "2026-11-02T21:11:00Z").join()).toMatch(/10 minutes/);
    expect(err("2026-11-02T19:00:00Z", "2026-11-02T19:05:00Z").join()).toMatch(/past/);
    expect(err("2026-11-20T21:00:00Z", "2026-11-20T21:05:00Z").join()).toMatch(/14 days/);
  });
});

describe("conflicts use absolute time", () => {
  const route = [{ lat: 40.70, lon: -74.01 }, { lat: 40.78, lon: -73.87 }];
  const mk = (id: string, startIso: string, band = "low"): FlightTrack => ({
    id, aircraftId: id, path: route, altitudeBand: band, cruiseKmh: 90,
    depStartMin: epochMinutes(startIso), depEndMin: epochMinutes(startIso) + 10,
  });
  it("same route, same clock time, different DATES → no conflict", () => {
    const r = checkNetwork(mk("a", "2026-11-03T15:00:00Z"), [mk("b", "2026-11-04T15:00:00Z")]);
    expect(r.status).toBe("checked_clear");
  });
  it("same route and overlapping time → conflict", () => {
    const r = checkNetwork(mk("a", "2026-11-03T15:00:00Z"), [mk("b", "2026-11-03T15:05:00Z")]);
    expect(r.status).toBe("conflicts");
  });
  it("flights crossing midnight UTC are compared correctly", () => {
    const r = checkNetwork(mk("a", "2026-11-03T23:58:00Z"), [mk("b", "2026-11-04T00:02:00Z")]);
    expect(r.status).toBe("conflicts");
  });
  it("traffic without coordinates is reported as skipped, not placed in New York", () => {
    const blind: FlightTrack = { ...mk("c", "2026-11-03T15:00:00Z"), path: [] };
    const r = checkNetwork(mk("a", "2026-11-03T15:00:00Z"), [blind]);
    expect(r.skipped).toHaveLength(1);
    expect(r.evaluatedCount).toBe(0);
  });
});

describe("vertiport matching", () => {
  const vps = [
    { id: "jrb", name: "Downtown Manhattan Heliport", lat: 40.7012, lon: -74.0091, max_departures_per_hour: 6, max_arrivals_per_hour: 6 },
    { id: "lga", name: "LaGuardia", lat: 40.7769, lon: -73.874, max_departures_per_hour: 6, max_arrivals_per_hour: 6 },
  ];
  it("matches the nearest pad within 3 km", () => {
    expect(nearestVertiport({ lat: 40.7040, lon: -74.0130 }, vps)?.vertiport.id).toBe("jrb");
  });
  it("returns null far from any pad (Boston) instead of a default", () => {
    expect(nearestVertiport({ lat: 42.361, lon: -71.057 }, vps)).toBeNull();
    expect(nearestVertiport(null, vps)).toBeNull();
  });
});

describe("traffic anonymisation", () => {
  it("is stable and hides the id", () => {
    const id = "6f1c2c1e-1111-4222-8333-944455556666";
    expect(trafficLabel(id)).toMatch(/^TFC-[0-9A-F]{4}$/);
    expect(trafficLabel(id)).toBe(trafficLabel(id));
    expect(trafficLabel(id)).not.toBe(trafficLabel(id.replace("6f", "7f")));
  });
});

describe("geocoding never invents a location", () => {
  it("parses tagged coordinates and known places; unknown text is null", () => {
    expect(resolveLocal("Pier 6 @ 40.7012,-74.0091")).toMatchObject({ lat: 40.7012, lon: -74.0091, source: "tagged" });
    expect(resolveLocal("Boston")?.lat).toBeCloseTo(42.361);
    expect(resolveLocal("Orlando")).toBeNull(); // used to resolve to "la" → Los Angeles
    expect(resolveLocal("Atlantis Spaceport")).toBeNull();
    // A specific address must not snap to a city centroid.
    expect(resolveLocal("Downtown Manhattan Heliport, New York")).toBeNull();
    expect(resolveLocal("Boston, MA")?.lat).toBeCloseTo(42.361);
    expect(resolveLocal("91,0")).toBeNull(); // out-of-range latitude
  });
});

describe("Open-Meteo 15-minute forecast parsing (real captured response)", () => {
  const json = JSON.parse(readFileSync("supabase/tests/fixtures/open-meteo-minutely15-JRB-2026-11-03T1500Z.json", "utf8"));
  const pts = parseMinutely(json);
  it("parses every slot as UTC", () => {
    expect(pts.length).toBe(4);
    expect(pts[0].time).toBe("2026-11-03T15:00Z");
    expect(new Date(pts[0].time).toISOString()).toBe("2026-11-03T15:00:00.000Z");
    expect(pts[0].windGustsKmh).toBeGreaterThan(0);
  });
  it("picks the slot at departure, +15, +30; nothing outside 15 minutes", () => {
    expect(pointAt(pts, new Date("2026-11-03T15:07:00Z"))?.time).toBe("2026-11-03T15:00Z");
    expect(pointAt(pts, new Date("2026-11-03T15:30:00Z"))?.time).toBe("2026-11-03T15:30Z");
    expect(pointAt(pts, new Date("2026-11-03T18:00:00Z"))).toBeNull();
  });
  it("drops slots with missing core fields instead of filling them", () => {
    const broken = structuredClone(json);
    broken.minutely_15.wind_gusts_10m[1] = null;
    expect(parseMinutely(broken).length).toBe(3);
    expect(parseMinutely({})).toEqual([]);
  });
  it("requests the 15-minute grid around the departure", () => {
    expect(slot15(new Date("2026-11-03T15:07:59Z"))).toBe("2026-11-03T15:00");
    expect(forecastUrl(40.7, -74, new Date("2026-11-03T15:07:00Z"))).toContain("start_minutely_15=2026-11-03T15:00&end_minutely_15=2026-11-03T15:45");
  });
});

describe("decision engine", () => {
  const base: DecisionInputs = {
    trajectoryScore: 90, conflicts: 0, conflictCheck: "checked_clear",
    weather: { available: true, riskScore: 10, forecast15: 10, forecast30: 10, trend: "stable" },
    airspace: { allocated: true, delayMinutes: 0, loadPct: 20 },
    vertiport: { checked: true, reserved: true, delayMinutes: 0 },
    route: { primaryId: "direct", primaryScore: 88, alternates: [{ id: "port-wide", label: "Port deviation (wide)", traffic_score: 90 }] },
    departureStart: new Date("2026-11-03T15:00:00Z"),
    userConfidenceAdj: 0,
  };
  it("issues GO only when everything is nominal", () => {
    const r = decide(base);
    expect(r.decision).toBe("GO");
    expect(r.departureTime.toISOString()).toBe("2026-11-03T15:00:00.000Z");
  });
  it("never issues GO without weather data", () => {
    const r = decide({ ...base, weather: { available: false } });
    expect(r.decision).toBe("DELAY");
    expect(r.simulation.safe).toBe(false);
    expect(r.reason).toMatch(/unavailable/);
  });
  it("holds when no airspace slot exists within the horizon", () => {
    expect(decide({ ...base, airspace: { allocated: false, delayMinutes: null, loadPct: 100 } }).decision).toBe("DELAY");
  });
  it("reroutes around high weather via the alternate candidate id", () => {
    const r = decide({ ...base, weather: { available: true, riskScore: 70, forecast15: 70, forecast30: 72, trend: "degrading" } });
    expect(r.decision).toBe("REROUTE");
    expect(r.routeCandidateId).toBe("port-wide");
  });
  it("applies slot delays to the departure time", () => {
    const r = decide({ ...base, airspace: { allocated: true, delayMinutes: 15, loadPct: 85 } });
    expect(r.decision).toBe("DELAY");
    expect(r.delayMinutes).toBe(15);
    expect(r.departureTime.toISOString()).toBe("2026-11-03T15:15:00.000Z");
  });
  it("states missing inputs and lowers confidence instead of hiding them", () => {
    const full = decide(base);
    const r = decide({ ...base, airspace: null, conflictCheck: "incomplete" });
    expect(r.confidence).toBeLessThan(full.confidence);
    expect(r.notes.join(" ")).toMatch(/Airspace capacity was not assessed/);
    expect(r.notes.join(" ")).toMatch(/Conflict check incomplete/);
  });
});
