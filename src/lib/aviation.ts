// Aviation-style communication helpers: headings and wind phrasing. Used in
// weather/monitoring surfaces so the UI talks to pilots in their own
// terminology instead of consumer-app sentences.

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Normalize any degree value into [0, 360). */
export function normalizeDeg(deg: number): number {
  const n = deg % 360;
  return n < 0 ? n + 360 : n;
}

/** Format a heading as a 3-digit string, e.g. 90 → "090". */
export function formatHeading(deg: number): string {
  const n = Math.round(normalizeDeg(deg));
  return n.toString().padStart(3, "0");
}

/** Cardinal label ("N", "NE", "SW", …) for a heading. */
export function cardinalLabel(deg: number): typeof CARDINALS[number] {
  const n = normalizeDeg(deg);
  // 8 sectors of 45°. 0° centered on N → range [-22.5, +22.5).
  const idx = Math.floor((n + 22.5) / 45) % 8;
  return CARDINALS[idx];
}

const KMH_PER_KNOT = 1.852;

/** Convert km/h → knots (aviation convention). */
export function kmhToKnots(kmh: number): number {
  return kmh / KMH_PER_KNOT;
}

/**
 * Wind callout like "Wind from 310 at 15 knots, gusting 22".
 * `windFromDeg` is the meteorological "wind from" direction.
 */
export function windCallout(windFromDeg: number, windSpeedKmh: number, gustsKmh?: number): string {
  const knots = Math.round(kmhToKnots(windSpeedKmh));
  const gust = gustsKmh && gustsKmh > windSpeedKmh + 5
    ? `, gusting ${Math.round(kmhToKnots(gustsKmh))}`
    : "";
  return `Wind from ${formatHeading(windFromDeg)} at ${knots} knots${gust}`;
}
