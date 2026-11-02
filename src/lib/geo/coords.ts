// Location → coordinate helpers shared by the Clearances preview map and the
// in-flight tracking map. Coordinates are NEVER adjusted to fit a view.
import type { Pt } from "@/lib/geo/region";
import type { RouteOptimizerResult } from "@/lib/routeTypes";

/** Well-known places, [lng, lat]. Only used when a location string carries no
 *  geocoded "@ lat,lon" tag (e.g. typed free text or older records). */
const CITY_COORDS: Record<string, [number, number]> = {
  "new york": [-73.985, 40.748], "nyc": [-73.985, 40.748],
  "manhattan": [-73.9712, 40.7831], "brooklyn": [-73.944, 40.678],
  "jfk": [-73.779, 40.641], "laguardia": [-73.872, 40.776],
  "newark": [-74.175, 40.69], "hoboken": [-74.031, 40.744],
  "jersey city": [-74.047, 40.718],
  "los angeles": [-118.243, 34.052], "chicago": [-87.623, 41.883],
  "miami": [-80.191, 25.761], "seattle": [-122.332, 47.606],
  "boston": [-71.057, 42.361], "san francisco": [-122.419, 37.774],
};

/** Parse "name @ lat,lon", bare "lat,lon", or a known place name. */
export function locationCoords(loc: string | null | undefined): Pt | null {
  if (!loc) return null;
  const tagged = loc.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  const bare = loc.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  const m = tagged ?? bare;
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  // Bare place names only — substring matching snapped addresses such as
  // "Downtown Manhattan Heliport" to a city centroid kilometres away.
  const v = CITY_COORDS[loc.toLowerCase().split(",")[0].trim()];
  return v ? { lat: v[1], lng: v[0] } : null;
}

/** Straight-line densification a→b (n segments). Densified so the simulated
 *  vehicle moves smoothly; no curvature is invented. */
export function densify(a: Pt, b: Pt, n = 160): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
  }
  return pts;
}

/** Waypoints of a route candidate as {lat,lng}, or null if unusable. */
function waypointsOf(route: { waypoints?: { lat: number; lon: number }[] } | null | undefined): Pt[] | null {
  const pts = (route?.waypoints ?? [])
    .filter((p) => typeof p?.lat === "number" && typeof p?.lon === "number")
    .map((p) => ({ lat: p.lat, lng: p.lon }));
  return pts.length >= 2 ? pts : null;
}

/** The route the decision engine picked (falls back to the primary route). */
export function plannedRoute(routeData: RouteOptimizerResult | null, decisionRouteId?: string | null): Pt[] | null {
  if (!routeData) return null;
  const matched = decisionRouteId ? routeData.alternate_routes.find((r) => r.id === decisionRouteId) : null;
  return waypointsOf(matched ?? routeData.primary_route);
}

/** All candidate routes, selected first, for the preview map. */
export function candidateRoutes(routeData: RouteOptimizerResult | null, selectedId?: string | null): Pt[][] {
  if (!routeData) return [];
  const all = [routeData.primary_route, ...routeData.alternate_routes];
  const sel = all.find((r) => r.id === selectedId) ?? routeData.primary_route;
  return [sel, ...all.filter((r) => r !== sel)]
    .map((r) => waypointsOf(r))
    .filter((p): p is Pt[] => !!p);
}

/** Total great-circle length of a polyline, in km. */
export function routeLengthKm(pts: Pt[]): number {
  let km = 0;
  const R = 6371, r = Math.PI / 180;
  for (let i = 1; i < pts.length; i++) {
    const dLat = (pts[i].lat - pts[i - 1].lat) * r;
    const dLng = (pts[i].lng - pts[i - 1].lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(pts[i - 1].lat * r) * Math.cos(pts[i].lat * r) * Math.sin(dLng / 2) ** 2;
    km += 2 * R * Math.asin(Math.sqrt(h));
  }
  return km;
}
