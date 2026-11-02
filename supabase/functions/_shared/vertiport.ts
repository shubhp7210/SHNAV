// Vertiport matching by real distance (pure). The old matcher fell back to
// vertiports[0] for anything it didn't recognise, so a Boston departure was
// capacity-checked against a Manhattan pad.

export interface VertiportRow {
  id: string;
  name: string;
  lat: number | string;
  lon: number | string;
  max_departures_per_hour: number;
  max_arrivals_per_hour: number;
  faa_id?: string | null;
}

export const MATCH_RADIUS_KM = 3;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Nearest active vertiport within `radiusKm`, or null (= not checked, never guessed). */
export function nearestVertiport<T extends VertiportRow>(
  point: { lat: number; lon: number } | null,
  vertiports: T[],
  radiusKm = MATCH_RADIUS_KM,
): { vertiport: T; distanceKm: number } | null {
  if (!point) return null;
  let best: { vertiport: T; distanceKm: number } | null = null;
  for (const v of vertiports) {
    const d = haversineKm(point.lat, point.lon, Number(v.lat), Number(v.lon));
    if (d <= radiusKm && (!best || d < best.distanceKm)) best = { vertiport: v, distanceKm: d };
  }
  return best;
}
