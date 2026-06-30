// Shared fleet/airspace constants. Single source of truth for values that
// were previously hardcoded in multiple edge functions — change here, every
// function updates.

/** eVTOL cruise airspeed used for time-of-flight estimates (km/h). */
export const EVTOL_BASE_SPEED_KMH = 90;

/** Minimum safe pairwise separation between active flights (km). */
export const MIN_SEPARATION_KM = 0.5;

/** CORS headers used by every edge function. Keep wide enough for the
 *  Supabase JS client's platform/runtime headers. */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/** Default coords when geocoding fails completely (NYC). */
export const DEFAULT_COORDS: readonly [number, number] = [40.7128, -74.006];
