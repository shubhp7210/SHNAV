// Geodesy helpers used by multiple edge functions. Previously these were
// duplicated in route-optimizer, trajectory-predictor, and vertiport-coordinator.

export type LatLon = [number, number];

/** Great-circle distance between two points (km). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from (lat1,lon1) → (lat2,lon2) in degrees [0, 360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Linear interpolation along a straight (lat, lon) segment at progress 0..1.
 *  Adequate for short hops (<<1000 km) where great-circle curvature is small. */
export function interpolatePosition(
  oLat: number, oLon: number,
  dLat: number, dLon: number,
  progress: number,
): { lat: number; lon: number } {
  const t = Math.max(0, Math.min(1, progress));
  return {
    lat: oLat + (dLat - oLat) * t,
    lon: oLon + (dLon - oLon) * t,
  };
}

/** Resolve wind components relative to the aircraft heading.
 *  Returns headwind (positive = slowing aircraft, negative = tailwind boost)
 *  and absolute crosswind, both in km/h.
 *  `windFromDeg` follows the meteorological convention ("direction the wind
 *  blows FROM"). */
export function windRelativeToHeading(
  headingDeg: number,
  windFromDeg: number,
  windSpeedKmh: number,
): { headwindKmh: number; crosswindKmh: number } {
  const windToDeg = (windFromDeg + 180) % 360;
  const relDeg = ((windToDeg - headingDeg + 540) % 360) - 180;
  const relRad = (relDeg * Math.PI) / 180;
  const tailwindComponent = Math.cos(relRad) * windSpeedKmh;
  const crosswindComponent = Math.sin(relRad) * windSpeedKmh;
  return {
    headwindKmh: -tailwindComponent,
    crosswindKmh: Math.abs(crosswindComponent),
  };
}
