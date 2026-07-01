// Shared fleet/airspace constants. Single source of truth for values that
// were previously hardcoded in multiple edge functions — change here, every
// function updates.

/** eVTOL cruise airspeed used for time-of-flight estimates (km/h). */
export const EVTOL_BASE_SPEED_KMH = 90;

/** Minimum safe pairwise separation between active flights (km). */
export const MIN_SEPARATION_KM = 0.5;

/** Default coords when geocoding fails completely (NYC). */
export const DEFAULT_COORDS: readonly [number, number] = [40.7128, -74.006];

const SHARED_ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version";

/**
 * Returns origin-aware CORS headers. In production set the ALLOWED_ORIGINS
 * environment variable to a comma-separated list of your app's URLs, e.g.:
 *   https://shnav.app,https://www.shnav.app
 * When the env var is not set the function falls back to "*" so local dev
 * still works without additional configuration.
 */
export function getCorsHeaders(req: Request): Record<string, string> {
  const raw = Deno.env.get("ALLOWED_ORIGINS") ?? "";
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";

  let allowOrigin: string;
  if (allowed.length === 0) {
    allowOrigin = "*";
  } else if (allowed.includes(origin)) {
    allowOrigin = origin;
  } else {
    // Origin not in the allow-list — respond with the first configured origin.
    // The browser will block the request (CORS policy), which is the intended
    // outcome. We never echo an untrusted origin back.
    allowOrigin = allowed[0];
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": SHARED_ALLOW_HEADERS,
    ...(allowed.length > 0 ? { "Vary": "Origin" } : {}),
  };
}

/** @deprecated Use getCorsHeaders(req) for origin-aware CORS. */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": SHARED_ALLOW_HEADERS,
};
