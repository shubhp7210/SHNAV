// Operating region for every map: North America (CONUS + Canada/Alaska/Mexico/
// Caribbean margins). Maps never stream or show geometry outside it — except
// that a route which genuinely leaves the region widens the bounds to include
// it, so no flight data is ever hidden.

export interface Pt { lat: number; lng: number }

export interface Bounds { west: number; south: number; east: number; north: number }

export const NORTH_AMERICA: Bounds = { west: -170, south: 14, east: -50, north: 72 };

/** Hard-coded default map location for every map: Manhattan, New York. */
export const MANHATTAN: Pt = { lat: 40.7831, lng: -73.9712 };

/** Target-based 3D camera view: the camera looks AT (lat,lng) from `range`
 *  metres away, rotated by `heading` and tilted by `pitch` (degrees). */
export interface TargetView { lat: number; lng: number; range: number; heading: number; pitch: number }

/** Manhattan's street grid runs ~29° east of true north — aligning the camera
 *  with it looks straight up the island. */
export const MANHATTAN_VIEW: TargetView = { ...MANHATTAN, range: 3400, heading: 29, pitch: -34 };

/** Nominal DISPLAY heights (m) for altitude bands. The backend defines bands only
 *  by name, so these are illustrative and always labeled as such in the UI. */
export const BAND_DISPLAY_HEIGHT_M: Record<string, number> = { low: 120, mid: 250, high: 400 };
export const bandHeight = (band?: string | null): number =>
  BAND_DISPLAY_HEIGHT_M[(band ?? "").toLowerCase()] ?? BAND_DISPLAY_HEIGHT_M.low;

export const inBounds = (b: Bounds, p: Pt): boolean =>
  p.lng >= b.west && p.lng <= b.east && p.lat >= b.south && p.lat <= b.north;

/** NA bounds, widened (with a margin) to contain any route points outside it. */
export function regionFor(routes: Pt[][], base: Bounds = NORTH_AMERICA): Bounds {
  const b = { ...base };
  const PAD = 2; // degrees
  for (const poly of routes) {
    for (const p of poly) {
      if (inBounds(base, p)) continue;
      b.west = Math.max(-180, Math.min(b.west, p.lng - PAD));
      b.east = Math.min(180, Math.max(b.east, p.lng + PAD));
      b.south = Math.max(-89, Math.min(b.south, p.lat - PAD));
      b.north = Math.min(89, Math.max(b.north, p.lat + PAD));
    }
  }
  return b;
}

/** Content key for a route set — lets effects depend on route *content*, not
 *  array identity (callers often rebuild arrays every render). */
export const routesKey = (routes: Pt[][]): string =>
  routes.map((poly) => poly.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(";")).join("|");

/** [lng, lat] center clamped into NA; anything outside falls back to Manhattan. */
export function centerInRegion(center: [number, number]): [number, number] {
  return inBounds(NORTH_AMERICA, { lng: center[0], lat: center[1] }) ? center : [MANHATTAN.lng, MANHATTAN.lat];
}
