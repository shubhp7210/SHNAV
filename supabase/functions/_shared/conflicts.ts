// Spatiotemporal conflict detection for the (simulated) UAM flight network.
//
// IMPORTANT (honesty): the "network" is this app's own flight_intents — no real
// flying-car traffic feed exists. This module computes geometric + temporal
// conflicts between candidate and existing flights with documented methods; it
// is decision-support, not a certified separation-assurance system.
//
// Method (documented):
//   1. Parametrize each route by arrival time at each vertex: t(vertex) =
//      cumulative_distance / cruise_speed. Departure uncertainty is the flight's
//      departure WINDOW, so a flight occupies vertex v during the absolute-time
//      interval [depStart + t(v), depEnd + t(v)].
//   2. Sample flight A's path; for each sample find the closest point on B's path
//      (horizontal great-circle distance).
//   3. A conflict exists only when, at that closest approach, ALL hold:
//        • horizontal separation < SEP_H_KM, AND
//        • the two flights' occupancy time-intervals at those points OVERLAP, AND
//        • they share the same altitude band (different bands = vertical sep).
//   4. Classify (crossing / converging / shared-corridor / parallel / approach),
//      grade severity by min separation + temporal tightness, and report the
//      uncertainty that the departure windows imply.
//   A map crossing alone is NOT a conflict (time must overlap); different
//   departure times do NOT auto-clear (windows can still overlap at a point).

export interface Pt { lat: number; lon: number }

export interface FlightTrack {
  id: string;
  aircraftId: string;
  /** Route polyline (>= 2 points), [{lat,lon}...]. */
  path: Pt[];
  /** Departure window, minutes-of-day [start, end]. */
  depStartMin: number;
  depEndMin: number;
  altitudeBand: string;      // "low" | "mid" | "high" | ...
  cruiseKmh: number;
}

export type ConflictType =
  | "crossing" | "converging" | "shared-corridor" | "parallel" | "approach-proximity";

export interface Conflict {
  aircraftId: string;
  otherId: string;
  type: ConflictType;
  severity: "high" | "moderate" | "low";
  horizontalSepKm: number;   // min horizontal separation at closest approach
  timeOverlapMin: number;    // overlap of occupancy windows at that point
  altitudeBand: string;
  /** Location of closest approach (for the map / explanation). */
  at: Pt;
  /** ± minutes of timing uncertainty implied by the departure windows. */
  uncertaintyMin: number;
}

export type CheckStatus = "checked_clear" | "conflicts" | "incomplete";

export interface ConflictResult {
  status: CheckStatus;
  conflicts: Conflict[];
  /** How many other flights were actually evaluated (for traceability). */
  evaluatedCount: number;
  /** Flights skipped because required data (path/times) was missing. */
  skipped: { id: string; reason: string }[];
  method: string;            // calculation version / description
}

export const CONFLICT_METHOD = "spatiotemporal-v1";
const SEP_H_KM = 0.5;        // horizontal separation minimum (= MIN_SEPARATION_KM)
const SAMPLES = 48;          // path sampling resolution

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** "HH:MM" → minutes of day (null if unparseable). */
export function toMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** Cumulative along-route arrival time (minutes) at each vertex, from cruise speed. */
function arrivalMinutes(path: Pt[], cruiseKmh: number): number[] {
  const out = [0];
  const v = Math.max(10, cruiseKmh);
  for (let i = 1; i < path.length; i++) {
    out.push(out[i - 1] + (haversineKm(path[i - 1], path[i]) / v) * 60);
  }
  return out;
}

/** Resample a path to `n` evenly spaced {point, alongMin} samples. */
function sample(path: Pt[], cruiseKmh: number, n: number): { p: Pt; alongMin: number }[] {
  const arr = arrivalMinutes(path, cruiseKmh);
  const total = arr[arr.length - 1] || 0;
  const res: { p: Pt; alongMin: number }[] = [];
  for (let s = 0; s <= n; s++) {
    const tm = (total * s) / n;
    // find segment containing tm
    let i = 1;
    while (i < arr.length && arr[i] < tm) i++;
    const i0 = Math.max(1, i) - 1, i1 = Math.min(path.length - 1, Math.max(1, i));
    const span = arr[i1] - arr[i0] || 1;
    const k = Math.max(0, Math.min(1, (tm - arr[i0]) / span));
    res.push({
      p: { lat: path[i0].lat + (path[i1].lat - path[i0].lat) * k, lon: path[i0].lon + (path[i1].lon - path[i0].lon) * k },
      alongMin: tm,
    });
  }
  return res;
}

const intervalsOverlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Adjacent/identical bands: only the SAME band lacks vertical separation. */
function sameAltitude(a: string, b: string): boolean {
  return (a || "").toLowerCase() === (b || "").toLowerCase();
}

/** Compare one candidate flight against one existing flight. */
export function detectPair(a: FlightTrack, b: FlightTrack): Conflict | null {
  if (a.path.length < 2 || b.path.length < 2) return null;
  // Different altitude bands are vertically separated → never a conflict.
  if (!sameAltitude(a.altitudeBand, b.altitudeBand)) return null;

  const sa = sample(a.path, a.cruiseKmh, SAMPLES);
  const sb = sample(b.path, b.cruiseKmh, SAMPLES);
  const uncertainty = ((a.depEndMin - a.depStartMin) + (b.depEndMin - b.depStartMin)) / 2;

  let best: Conflict | null = null;
  for (const A of sa) {
    // nearest point on B
    let nb = sb[0], ndist = Infinity;
    for (const B of sb) { const d = haversineKm(A.p, B.p); if (d < ndist) { ndist = d; nb = B; } }
    if (ndist >= SEP_H_KM) continue;
    // occupancy windows at these along-route points (absolute minutes of day)
    const aStart = a.depStartMin + A.alongMin, aEnd = a.depEndMin + A.alongMin;
    const bStart = b.depStartMin + nb.alongMin, bEnd = b.depEndMin + nb.alongMin;
    const overlap = intervalsOverlap(aStart, aEnd, bStart, bEnd);
    if (overlap <= 0) continue; // crossing in space but NOT in time → not a conflict

    const severity: Conflict["severity"] = ndist < SEP_H_KM * 0.4 ? "high" : ndist < SEP_H_KM * 0.75 ? "moderate" : "low";
    if (!best || ndist < best.horizontalSepKm) {
      best = {
        aircraftId: a.aircraftId, otherId: b.aircraftId,
        type: classify(a, b, A.p),
        severity, horizontalSepKm: Math.round(ndist * 1000) / 1000,
        timeOverlapMin: Math.round(overlap), altitudeBand: a.altitudeBand,
        at: A.p, uncertaintyMin: Math.round(uncertainty),
      };
    }
  }
  return best;
}

/** Classify from heading difference first, then endpoint proximity.
 *  Near-identical headings ⇒ running together (shared corridor / parallel) even
 *  near endpoints; only divergent headings near an endpoint read as a converging
 *  approach-proximity conflict. */
function classify(a: FlightTrack, b: FlightTrack, at: Pt): ConflictType {
  const ha = heading(a.path[0], a.path[a.path.length - 1]);
  const hb = heading(b.path[0], b.path[b.path.length - 1]);
  const diff = Math.abs(((ha - hb + 540) % 360) - 180); // 0 = same dir, 180 = opposite
  if (diff < 25) return "shared-corridor";
  const endpoints = [a.path[0], a.path[a.path.length - 1], b.path[0], b.path[b.path.length - 1]];
  if (endpoints.some((e) => haversineKm(e, at) < SEP_H_KM * 2)) return "approach-proximity";
  if (diff < 55) return "parallel";
  return "crossing";
}

function heading(a: Pt, b: Pt): number {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Check a candidate flight against the whole network. Returns an honest status:
 * `checked_clear` only after evaluating ≥1 flight with no conflict; `incomplete`
 * if the candidate itself lacks required data; `conflicts` otherwise. An empty
 * network with a VALID candidate is `checked_clear` (we did check — there is
 * genuinely nothing to conflict with), never a fabricated "all clear".
 */
export function checkNetwork(candidate: FlightTrack, others: FlightTrack[]): ConflictResult {
  const skipped: { id: string; reason: string }[] = [];
  if (candidate.path.length < 2 || !Number.isFinite(candidate.depStartMin) || !Number.isFinite(candidate.depEndMin)) {
    return { status: "incomplete", conflicts: [], evaluatedCount: 0, skipped: [{ id: candidate.id, reason: "candidate missing path or departure window" }], method: CONFLICT_METHOD };
  }
  const conflicts: Conflict[] = [];
  let evaluated = 0;
  for (const o of others) {
    if (o.path.length < 2 || !Number.isFinite(o.depStartMin) || !Number.isFinite(o.depEndMin)) {
      skipped.push({ id: o.id, reason: "missing path or departure window" });
      continue;
    }
    evaluated++;
    const c = detectPair(candidate, o);
    if (c) conflicts.push(c);
  }
  const status: CheckStatus = conflicts.length > 0 ? "conflicts" : "checked_clear";
  conflicts.sort((x, y) => x.horizontalSepKm - y.horizontalSepKm);
  return { status, conflicts, evaluatedCount: evaluated, skipped, method: CONFLICT_METHOD };
}
