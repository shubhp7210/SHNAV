// Aviation-style communication helpers: clock-position callouts, headings,
// and wind phrasing. Used in monitoring/conflict callouts so the UI talks
// to pilots in their own terminology instead of consumer-app sentences.

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

/**
 * Clock position of a target from the observer's perspective.
 * `ownHeadingDeg` = the observer's current bearing (where the nose points).
 * `targetBearingDeg` = bearing from observer to target.
 * Returns the integer clock face position (1..12) where 12 is dead ahead.
 */
export function clockPosition(ownHeadingDeg: number, targetBearingDeg: number): number {
  const rel = normalizeDeg(targetBearingDeg - ownHeadingDeg);
  // 30° per hour, with 12 o'clock at 0°. 1 o'clock = 30°, 6 o'clock = 180°.
  const hour = Math.round(rel / 30);
  // Map 0 → 12 (dead ahead).
  return hour === 0 ? 12 : hour;
}

/**
 * Build a pilot-style traffic callout, e.g. "Traffic 2 o'clock, 1.2 km".
 * Distance can be omitted if unknown.
 */
export function trafficCallout(
  ownHeadingDeg: number,
  targetBearingDeg: number,
  distanceKm?: number
): string {
  const clock = clockPosition(ownHeadingDeg, targetBearingDeg);
  const dist = typeof distanceKm === "number"
    ? `, ${distanceKm < 1 ? Math.round(distanceKm * 1000) + " m" : distanceKm.toFixed(1) + " km"}`
    : "";
  return `Traffic ${clock} o'clock${dist}`;
}

/** "Turn heading 090 east" — for advisory route adjustments. */
export function turnInstruction(headingDeg: number): string {
  return `Turn heading ${formatHeading(headingDeg)} ${cardinalLabel(headingDeg)}`;
}

/** "Maintain heading 270 west" — for hold-current callouts. */
export function maintainInstruction(headingDeg: number): string {
  return `Maintain heading ${formatHeading(headingDeg)} ${cardinalLabel(headingDeg)}`;
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

/** Side-of-aircraft summary for proximity alerts: left / right / ahead / behind. */
export function sideOfAircraft(
  ownHeadingDeg: number,
  targetBearingDeg: number
): "ahead" | "right" | "behind" | "left" {
  const rel = normalizeDeg(targetBearingDeg - ownHeadingDeg);
  if (rel < 45 || rel >= 315) return "ahead";
  if (rel >= 45 && rel < 135) return "right";
  if (rel >= 135 && rel < 225) return "behind";
  return "left";
}

/** "Traffic off your right side" style summary used in audio callouts. */
export function trafficSideCallout(ownHeadingDeg: number, targetBearingDeg: number): string {
  const side = sideOfAircraft(ownHeadingDeg, targetBearingDeg);
  if (side === "ahead") return "Traffic ahead";
  if (side === "behind") return "Traffic behind";
  return `Traffic off your ${side} side`;
}

/** Resolution-action phrasing for the conflict resolver. */
export function resolutionCallout(
  type: "route_deviation" | "speed_adjustment" | "altitude_adjustment" | string,
  ownHeadingDeg: number,
  deviationDeg = 15
): string {
  if (type === "route_deviation") {
    const newHeading = normalizeDeg(ownHeadingDeg + deviationDeg);
    return `Turn heading ${formatHeading(newHeading)} ${cardinalLabel(newHeading)} for separation`;
  }
  if (type === "speed_adjustment") return "Reduce speed for separation";
  if (type === "altitude_adjustment") return "Step climb 200 feet for separation";
  return "Maintain current heading and monitor";
}
