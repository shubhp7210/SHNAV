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

/** Local development origins permitted when no ALLOWED_ORIGINS is configured. */
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Returns origin-aware CORS headers. In production you MUST set the
 * ALLOWED_ORIGINS environment variable to a comma-separated list of your app's
 * URLs, e.g.:
 *   https://shnav.app,https://www.shnav.app
 *
 * Fail-closed behaviour: when ALLOWED_ORIGINS is not set, only local-development
 * origins (localhost / 127.0.0.1) are permitted. We never fall back to "*", so a
 * production deploy that forgets to configure ALLOWED_ORIGINS will have its
 * cross-origin calls blocked by the browser rather than allowing any site on the
 * internet to invoke these functions. (The JWT check still protects the data
 * either way; this prevents cross-origin abuse and drive-by invocation.)
 */
export function getCorsHeaders(req: Request): Record<string, string> {
  const raw = Deno.env.get("ALLOWED_ORIGINS") ?? "";
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";

  let allowOrigin: string;
  if (allowed.length > 0) {
    // Explicit allow-list (production): echo the origin only when it matches.
    // Otherwise return the first configured origin so the browser blocks the
    // request — we never echo an untrusted origin back.
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  } else if (DEV_ORIGIN_RE.test(origin)) {
    // No allow-list configured — permit local dev origins only.
    allowOrigin = origin;
  } else {
    // No allow-list and a non-local origin: return a value that cannot match,
    // so the browser's CORS check blocks the request. Fails closed.
    allowOrigin = "null";
  }

  // Response varies by Origin in every branch now, so always advertise it.
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": SHARED_ALLOW_HEADERS,
    "Vary": "Origin",
  };
}
