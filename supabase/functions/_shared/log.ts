// Structured logging + error capture + external-API usage metering.
// Errors land in public.error_events (service-role only); check_alerts() turns
// spikes into alerts. Usage lands in public.api_usage for budget alarms.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export function logInfo(fn: string, msg: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", fn, msg, ts: new Date().toISOString(), ...data }));
}

export async function reportError(
  admin: SupabaseClient,
  fn: string,
  err: unknown,
  context: Record<string, unknown> = {},
  userId: string | null = null,
  level: "warning" | "error" | "fatal" = "error",
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(JSON.stringify({ level, fn, msg: message, ts: new Date().toISOString(), ...context }));
  try {
    await admin.from("error_events").insert({
      source: "edge", fn, level, user_id: userId,
      message: message.slice(0, 2000),
      context: { ...context, stack: stack?.slice(0, 4000) },
    });
  } catch { /* never let error reporting break the request */ }
}

// External calls are counted per isolate and flushed after each request.
// take*() reads-and-resets, so concurrent requests never double count.
const counters = new Map<string, number>();
export function countCall(service: string, n = 1): void {
  counters.set(service, (counters.get(service) ?? 0) + n);
}
export async function flushUsage(admin: SupabaseClient): Promise<void> {
  const entries = [...counters.entries()];
  counters.clear();
  await Promise.allSettled(entries.map(([service, n]) =>
    admin.rpc("track_api_usage", { p_service: service, p_calls: n })));
}
