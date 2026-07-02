import { describe, it, expect } from "vitest";
import { normalizeDeg, formatHeading, cardinalLabel, kmhToKnots, windCallout } from "./aviation";

describe("normalizeDeg", () => {
  it("wraps values into [0, 360)", () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(725)).toBe(5);
  });
});

describe("formatHeading", () => {
  it("pads to three figures", () => {
    expect(formatHeading(5)).toBe("005");
    expect(formatHeading(90)).toBe("090");
    expect(formatHeading(270)).toBe("270");
  });

  it("normalizes out-of-range headings", () => {
    expect(formatHeading(-10)).toBe("350");
    expect(formatHeading(365)).toBe("005");
  });
});

describe("cardinalLabel", () => {
  it("maps headings to 8 sectors centered on the cardinal", () => {
    expect(cardinalLabel(0)).toBe("N");
    expect(cardinalLabel(22)).toBe("N");
    expect(cardinalLabel(23)).toBe("NE");
    expect(cardinalLabel(90)).toBe("E");
    expect(cardinalLabel(180)).toBe("S");
    expect(cardinalLabel(315)).toBe("NW");
    expect(cardinalLabel(350)).toBe("N");
  });
});

describe("kmhToKnots", () => {
  it("converts using 1 kt = 1.852 km/h", () => {
    expect(kmhToKnots(1.852)).toBeCloseTo(1, 5);
    expect(kmhToKnots(92.6)).toBeCloseTo(50, 5);
    expect(kmhToKnots(0)).toBe(0);
  });
});

describe("windCallout", () => {
  it("formats direction and speed in knots", () => {
    expect(windCallout(310, 27.78)).toBe("Wind from 310 at 15 knots");
  });

  it("includes gusts only when meaningfully above the base wind", () => {
    expect(windCallout(90, 20, 40)).toBe("Wind from 090 at 11 knots, gusting 22");
    expect(windCallout(90, 20, 22)).toBe("Wind from 090 at 11 knots");
  });
});
