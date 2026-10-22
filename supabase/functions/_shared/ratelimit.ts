// Per-user rate limiting for edge functions, backed by the atomic
// public.check_rate_limit() SQL function (see migration 20261019000000_rate_limiting.sql).
//
// Usage inside a function, after requireUserAuth + service-role client creation:
//
//   const rl = await checkRateLimit(supabase, user.id, "route-optimizer", 30, 60);
//   if (!rl.allowed) return tooManyRequests(corsHeaders, rl.windowSeconds);
//
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  windowSeconds: number;
}

/**
 * Fixed-window per-user rate limit. `admin` must be a service-role client (the
 * check_rate_limit function is granted to service_role only).
 *
 * Fails OPEN on infrastructure errors: a transient DB problem must not take the
 * whole API down. Flip the two `allowed: true` returns to `false` if you would
 * rather fail closed.
 */
export async function checkRateLimit(
  admin: SupabaseClient,
  userId: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const { data, error } = await admin.rpc("check_rate_limit", {
      p_user_id: userId,
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.error("[ratelimit] rpc error:", error.message);
      return { allowed: true, limit, windowSeconds };
    }
    return { allowed: data === true, limit, windowSeconds };
  } catch (e) {
    console.error("[ratelimit] unexpected error:", e);
    return { allowed: true, limit, windowSeconds };
  }
}

/** Standard 429 response with a Retry-After hint. */
export function tooManyRequests(
  corsHeaders: Record<string, string>,
  windowSeconds: number,
): Response {
  return new Response(
    JSON.stringify({ error: "Rate limit exceeded. Please slow down and retry shortly." }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(windowSeconds),
      },
    },
  );
}
