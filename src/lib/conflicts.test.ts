import { describe, it, expect } from "vitest";
import {
  checkNetwork, detectPair, type FlightTrack,
} from "../../supabase/functions/_shared/conflicts";

// Two routes that cross near (40.75, -73.975): A west→east, B south→north.
const routeA = [{ lat: 40.75, lon: -74.0 }, { lat: 40.75, lon: -73.95 }];
const routeB = [{ lat: 40.73, lon: -73.975 }, { lat: 40.77, lon: -73.975 }];

const mk = (over: Partial<FlightTrack>): FlightTrack => ({
  id: "x", aircraftId: "X", path: routeA,
  depStartMin: 600, depEndMin: 660, altitudeBand: "low", cruiseKmh: 90, ...over,
});

describe("spatiotemporal conflict detection", () => {
  it("flags crossing routes with overlapping time + same altitude", () => {
    const a = mk({ id: "a", aircraftId: "A", path: routeA });
    const b = mk({ id: "b", aircraftId: "B", path: routeB });
    const c = detectPair(a, b);
    expect(c).not.toBeNull();
    expect(c!.horizontalSepKm).toBeLessThan(0.5);
    expect(["crossing", "parallel", "approach-proximity"]).toContain(c!.type);
  });

  it("does NOT flag a map crossing when departure times don't overlap in time", () => {
    const a = mk({ id: "a", aircraftId: "A", path: routeA, depStartMin: 600, depEndMin: 660 });
    const b = mk({ id: "b", aircraftId: "B", path: routeB, depStartMin: 720, depEndMin: 780 });
    expect(detectPair(a, b)).toBeNull();
  });

  it("does NOT flag flights in different altitude bands (vertical separation)", () => {
    const a = mk({ id: "a", aircraftId: "A", path: routeA, altitudeBand: "low" });
    const b = mk({ id: "b", aircraftId: "B", path: routeB, altitudeBand: "high" });
    expect(detectPair(a, b)).toBeNull();
  });

  it("flags a shared corridor (near-identical path, same direction, same time)", () => {
    const a = mk({ id: "a", aircraftId: "A", path: routeA });
    const b = mk({ id: "b", aircraftId: "B", path: [{ lat: 40.7502, lon: -74.0 }, { lat: 40.7502, lon: -73.95 }] });
    const c = detectPair(a, b);
    expect(c).not.toBeNull();
    expect(c!.type).toBe("shared-corridor");
  });

  it("reports timing uncertainty from the departure windows", () => {
    const a = mk({ id: "a", aircraftId: "A", path: routeA, depStartMin: 600, depEndMin: 660 });
    const b = mk({ id: "b", aircraftId: "B", path: routeB, depStartMin: 600, depEndMin: 660 });
    const c = detectPair(a, b);
    expect(c!.uncertaintyMin).toBe(60);
  });
});

describe("network check honesty", () => {
  it("empty network with a VALID candidate is checked_clear, not fabricated", () => {
    const r = checkNetwork(mk({ id: "a", aircraftId: "A" }), []);
    expect(r.status).toBe("checked_clear");
    expect(r.evaluatedCount).toBe(0);
    expect(r.conflicts).toHaveLength(0);
  });

  it("an invalid candidate yields `incomplete`, never checked_clear", () => {
    const r = checkNetwork(mk({ id: "a", aircraftId: "A", path: [{ lat: 40.75, lon: -74 }] }), [
      mk({ id: "b", aircraftId: "B", path: routeB }),
    ]);
    expect(r.status).toBe("incomplete");
  });

  it("skips others with missing data but still evaluates the rest", () => {
    const r = checkNetwork(mk({ id: "a", aircraftId: "A", path: routeA }), [
      mk({ id: "bad", aircraftId: "BAD", path: [{ lat: 1, lon: 1 }] }),
      mk({ id: "b", aircraftId: "B", path: routeB }),
    ]);
    expect(r.evaluatedCount).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.status).toBe("conflicts");
  });
});
