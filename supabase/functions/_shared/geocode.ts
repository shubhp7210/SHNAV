// Location → coordinates for every edge function.
//
// Resolution order:
//   1. Tagged "name @ lat,lon" or bare "lat,lon" (what the location search sends)
//   2. Known-place table
//   3. geocode_cache (DB) — positive results kept, negative results for 1 day
//   4. Nominatim, throttled to ≤1 request/second per OSM's usage policy
// Unresolvable input returns NULL. The old code silently returned New York,
// which placed unknown flights in Manhattan for conflict and weather checks.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { LatLon } from "./geo.ts";
import { countCall } from "./log.ts";

export interface Resolved { lat: number; lon: number; source: "tagged" | "table" | "cache" | "nominatim" }

const CITY_COORDS: Record<string, LatLon> = {
  "new york":      [40.7128,  -74.006],
  "nyc":           [40.7128,  -74.006],
  "manhattan":     [40.7831,  -73.9712],
  "brooklyn":      [40.678,   -73.944],
  "jfk":           [40.6413,  -73.7781],
  "laguardia":     [40.7769,  -73.874],
  "newark":        [40.6895,  -74.1745],
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
  "la":            [34.0522, -118.2437],
  "sf":            [37.7749, -122.4194],
};

export function parseTaggedCoords(location: string): LatLon | null {
  const m = location.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/) ??
    location.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

/** Synchronous lookups only (tag + known places). */
export function resolveLocal(location: string | null | undefined): Resolved | null {
  if (!location?.trim()) return null;
  const tagged = parseTaggedCoords(location);
  if (tagged) return { lat: tagged[0], lon: tagged[1], source: "tagged" };
  // Only a bare place name ("Boston", "Boston, MA") uses the table. Word
  // matching inside longer text snapped addresses to city centroids — e.g.
  // "Downtown Manhattan Heliport, New York" landed 9 km away in Central Park.
  const key = location.toLowerCase().split(",")[0].trim();
  const hit = CITY_COORDS[key];
  return hit ? { lat: hit[0], lon: hit[1], source: "table" } : null;
}

// Per-isolate serialisation so concurrent requests never exceed 1 req/s.
let nominatimChain: Promise<unknown> = Promise.resolve();
let lastNominatimAt = 0;
function throttledNominatim(q: string): Promise<Response> {
  const run = async () => {
    const wait = lastNominatimAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    countCall("nominatim");
    return fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": "SHNAV-ATM/1.0 (flight planning; contact via app)", "Accept-Language": "en" },
      signal: AbortSignal.timeout(6000),
    });
  };
  const p = nominatimChain.then(run, run);
  nominatimChain = p.catch(() => undefined);
  return p;
}

export async function resolveLocation(admin: SupabaseClient | null, location: string | null | undefined): Promise<Resolved | null> {
  const local = resolveLocal(location);
  if (local || !location?.trim()) return local;
  const norm = location.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);

  if (admin) {
    const { data } = await admin.from("geocode_cache").select("lat, lon, resolved_at").eq("query_norm", norm).maybeSingle();
    if (data) {
      if (data.lat != null && data.lon != null) return { lat: data.lat, lon: data.lon, source: "cache" };
      if (Date.now() - new Date(data.resolved_at).getTime() < 86_400_000) return null; // recent negative
    }
  }

  let result: Resolved | null = null;
  try {
    const res = await throttledNominatim(location);
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
        result = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), source: "nominatim" };
      }
    } else {
      console.error(JSON.stringify({ level: "warning", fn: "geocode", msg: `Nominatim HTTP ${res.status}` }));
      return null; // do not cache transient failures
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "warning", fn: "geocode", msg: String(e) }));
    return null;
  }
  if (admin) {
    await admin.from("geocode_cache").upsert({
      query_norm: norm, lat: result?.lat ?? null, lon: result?.lon ?? null,
      source: "nominatim", resolved_at: new Date().toISOString(),
    });
  }
  return result;
}
