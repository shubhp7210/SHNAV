// Frontend error capture → log-client-error edge function → error_events.
// De-duplicated and throttled in the browser (≤5 reports/min); the server also
// rate-limits. Dev builds log to the console only.
import { supabase } from "@/integrations/supabase/client";

type Kind = "boundary" | "window.onerror" | "unhandledrejection" | "manual";

const recent = new Map<string, number>();
let windowStart = Date.now();
let sentInWindow = 0;

export function reportClientError(err: unknown, kind: Kind = "manual", level: "warning" | "error" | "fatal" = "error"): void {
  const message = (err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err ?? "unknown")).slice(0, 2000);
  const stack = err instanceof Error ? err.stack?.slice(0, 6000) : undefined;
  if (!import.meta.env.PROD) { console.warn(`[error-report:${kind}]`, message); return; }

  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; sentInWindow = 0; }
  const key = `${kind}:${message}`;
  if ((recent.get(key) ?? 0) > now - 5 * 60_000 || sentInWindow >= 5) return;
  recent.set(key, now);
  sentInWindow++;

  void supabase.functions.invoke("log-client-error", {
    body: { message, stack, kind, level, url: location.href.slice(0, 500), release: import.meta.env.VITE_RELEASE ?? undefined },
  }).catch(() => { /* never throw from the reporter */ });
}

let installed = false;
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    // Resource-load errors (img/script) have no error object; skip noise.
    if (e.error) reportClientError(e.error, "window.onerror");
  });
  window.addEventListener("unhandledrejection", (e) => reportClientError(e.reason, "unhandledrejection"));
}
