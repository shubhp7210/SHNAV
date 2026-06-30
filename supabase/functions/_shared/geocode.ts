// Single source of truth for location → (lat, lon) resolution across edge
// functions. Replaces four divergent city tables that previously caused the
// same input string to resolve differently in different functions.
//
// Resolution order:
//   1. Tagged coord form "name @ lat,lon" or bare "lat,lon"
//   2. Known-city table (substring match)
//   3. Nominatim (OpenStreetMap) reverse-fallback
//   4. DEFAULT_COORDS (NYC)
import { DEFAULT_COORDS } from "./constants.ts";
import type { LatLon } from "./geo.ts";

// Merged from the four prior tables (route-optimizer / trajectory-analysis /
// trajectory-predictor / weather-intelligence). Keys are matched as substrings
// against the lowercased input, so longer keys must precede shorter aliases
// when both could match.
const CITY_COORDS: Record<string, LatLon> = {
  // North America
  "new york":      [40.7128,  -74.006],
  "nyc":           [40.7128,  -74.006],
  "manhattan":     [40.776,   -73.97],
  "brooklyn":      [40.678,   -73.944],
  "jfk":           [40.641,   -73.779],
  "laguardia":     [40.776,   -73.872],
  "newark":        [40.69,    -74.175],
  "boston":        [42.361,   -71.057],
  "chicago":       [41.883,   -87.623],
  "los angeles":   [34.0522, -118.2437],
  "lax":           [33.942,  -118.408],
  "san francisco": [37.7749, -122.4194],
  "houston":       [29.7604,  -95.3698],
  "miami":         [25.7617,  -80.1918],
  "seattle":       [47.6062, -122.3321],
  "dallas":        [32.7767,  -96.797],
  "atlanta":       [33.749,   -84.388],
  "denver":        [39.7392, -104.9903],
  // Common 2-letter aliases — kept last so longer city names win the substring
  // race when both appear (e.g. "Los Angeles" before "la").
  "la":            [34.0522, -118.2437],
  "sf":            [37.7749, -122.4194],
  // International
  "london":        [51.5074,   -0.1278],
  "paris":         [48.864,     2.349],
  "dubai":         [25.2048,   55.2708],
  "tokyo":         [35.6762,  139.6503],
  "singapore":     [ 1.3521,  103.8198],
};

/** Parse "name @ lat,lon" or bare "lat,lon" forms. */
export function parseTaggedCoords(location: string): LatLon | null {
  const tagged = location.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (tagged) {
    const lat = parseFloat(tagged[1]);
    const lon = parseFloat(tagged[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }
  const bare = location.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lon = parseFloat(bare[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }
  return null;
}

/** Resolve a free-text location to (lat, lon). Async because of the Nominatim
 *  fallback; the local lookups all return synchronously. */
export async function getCoords(location: string): Promise<LatLon> {
  if (!location?.trim()) return [...DEFAULT_COORDS] as LatLon;

  const parsed = parseTaggedCoords(location);
  if (parsed) return parsed;

  const key = location.toLowerCase().trim();
  // Longest key first so "los angeles" wins over "la".
  const keys = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (key.includes(k)) return CITY_COORDS[k];
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
      { headers: { "User-Agent": "Altos-ATM/1.0", "Accept-Language": "en" } },
    );
    const arr = await res.json();
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
      return [parseFloat(arr[0].lat), parseFloat(arr[0].lon)];
    }
  } catch (error) {
    console.error("[geocode] Nominatim lookup failed:", error);
  }

  return [...DEFAULT_COORDS] as LatLon;
}

/** Object-shaped variant for callers that prefer `{lat, lon}` over a tuple. */
export async function getCoordsObj(location: string): Promise<{ lat: number; lon: number }> {
  const [lat, lon] = await getCoords(location);
  return { lat, lon };
}
