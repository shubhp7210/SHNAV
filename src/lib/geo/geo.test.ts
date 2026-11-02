import { describe, it, expect } from "vitest";
import { MANHATTAN, MANHATTAN_VIEW, bandHeight, centerInRegion, regionFor, NORTH_AMERICA } from "./region";
import { locationCoords, densify, candidateRoutes, plannedRoute, routeLengthKm } from "./coords";
import type { RouteOptimizerResult } from "@/lib/routeTypes";

describe("Manhattan default", () => {
  it("is hard-coded to Manhattan, New York", () => {
    expect(MANHATTAN).toEqual({ lat: 40.7831, lng: -73.9712 });
    expect(MANHATTAN_VIEW.lat).toBe(40.7831);
    expect(MANHATTAN_VIEW.lng).toBe(-73.9712);
  });
  it("starts in a tilted 3D city view, not a global view", () => {
    expect(MANHATTAN_VIEW.pitch).toBeLessThan(-20);
    expect(MANHATTAN_VIEW.pitch).toBeGreaterThan(-60);
    expect(MANHATTAN_VIEW.range).toBeLessThan(10_000);
  });
  it("falls back to Manhattan for centers outside the region", () => {
    expect(centerInRegion([0, 51])).toEqual([MANHATTAN.lng, MANHATTAN.lat]);
    expect(centerInRegion([-87.6, 41.9])).toEqual([-87.6, 41.9]);
  });
  it("never alters routes — the region widens to include them instead", () => {
    const lhr = [{ lat: 40.64, lng: -73.78 }, { lat: 51.47, lng: -0.45 }];
    const b = regionFor([lhr]);
    expect(b.east).toBeGreaterThan(-0.45);
    expect(b.north).toBeGreaterThan(51.47);
    expect(regionFor([[MANHATTAN]])).toEqual(NORTH_AMERICA);
  });
});

describe("altitude band display height", () => {
  it("maps known bands and defaults to low", () => {
    expect(bandHeight("low")).toBe(120);
    expect(bandHeight("MID")).toBe(250);
    expect(bandHeight("high")).toBe(400);
    expect(bandHeight(undefined)).toBe(120);
    expect(bandHeight("weird")).toBe(120);
  });
});

describe("locationCoords", () => {
  it("parses geocoded tags exactly", () => {
    expect(locationCoords("Downtown Skyport @ 40.7010,-74.0090")).toEqual({ lat: 40.701, lng: -74.009 });
  });
  it("parses bare lat,lon", () => {
    expect(locationCoords("40.5, -73.9")).toEqual({ lat: 40.5, lng: -73.9 });
  });
  it("resolves known places and rejects unknown text", () => {
    expect(locationCoords("Boston")).toEqual({ lat: 42.361, lng: -71.057 });
    expect(locationCoords("Atlantis")).toBeNull();
    expect(locationCoords("")).toBeNull();
  });
});

describe("densify", () => {
  it("is a straight line with exact endpoints (no invented curvature)", () => {
    const a = { lat: 40.7, lng: -74.0 }, b = { lat: 40.8, lng: -73.9 };
    const pts = densify(a, b, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual(a);
    expect(pts[10].lat).toBeCloseTo(b.lat, 12);
    expect(pts[10].lng).toBeCloseTo(b.lng, 12);
    for (const p of pts) expect(p.lat - a.lat).toBeCloseTo(p.lng - a.lng, 9); // on the a→b diagonal
  });
  it("lengths are great-circle km", () => {
    // JFK → Boston ≈ 300 km
    const km = routeLengthKm([{ lat: 40.641, lng: -73.779 }, { lat: 42.361, lng: -71.057 }]);
    expect(km).toBeGreaterThan(280);
    expect(km).toBeLessThan(310);
  });
});

describe("route candidates", () => {
  const wp = (lat: number, lon: number) => ({ lat, lon });
  const rd = {
    route_id: "r",
    primary_route: { id: "p", waypoints: [wp(40.70, -74.0), wp(40.75, -73.98)] },
    alternate_routes: [
      { id: "a1", waypoints: [wp(40.70, -74.0), wp(40.72, -73.95)] },
      { id: "a2", waypoints: [wp(40.70, -74.0)] }, // unusable: one waypoint
    ],
  } as unknown as RouteOptimizerResult;

  it("puts the selected route first and drops unusable ones", () => {
    const r = candidateRoutes(rd, "a1");
    expect(r).toHaveLength(2);
    expect(r[0][1]).toEqual({ lat: 40.72, lng: -73.95 });
  });
  it("defaults to the primary route", () => {
    expect(candidateRoutes(rd, null)[0][1]).toEqual({ lat: 40.75, lng: -73.98 });
    expect(plannedRoute(rd, null)?.[1]).toEqual({ lat: 40.75, lng: -73.98 });
    expect(plannedRoute(rd, "a1")?.[1]).toEqual({ lat: 40.72, lng: -73.95 });
    expect(plannedRoute(null)).toBeNull();
  });
});
