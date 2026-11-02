// Frontend error intake → public.error_events (source = 'client').
// Accepts the anon key (errors can happen before sign-in); rate-limited per
// user, or per client IP when signed out, and size-limited.
import { serve } from "../_shared/http.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { readBody, validateFields } from "../_shared/validate.ts";

/** Deterministic UUID from a string (rate-limit key for signed-out callers). */
async function uuidFrom(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const hex = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

serve("log-client-error", async ({ req, admin, json, cors }) => {
  let userId: string | null = null;
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const { data } = await admin.auth.getUser(auth.slice(7));
    userId = data.user?.id ?? null; // anon-key JWTs have no user — fine
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = await checkRateLimit(admin, userId ?? await uuidFrom(`ip:${ip}`), "log-client-error", 20, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const b = validateFields(await readBody(req), {
    message: { required: true, type: "string", maxLength: 2000 },
    level:   { type: "string", oneOf: ["warning", "error", "fatal"] },
    url:     { type: "string", maxLength: 500 },
    stack:   { type: "string", maxLength: 6000 },
    kind:    { type: "string", oneOf: ["boundary", "window.onerror", "unhandledrejection", "manual"] },
    release: { type: "string", maxLength: 64 },
  }) as Record<string, string | undefined>;

  const { error } = await admin.from("error_events").insert({
    source: "client", fn: b.kind ?? "manual", level: b.level ?? "error", user_id: userId,
    message: b.message,
    context: { url: b.url, stack: b.stack, release: b.release, ua: req.headers.get("user-agent")?.slice(0, 300) },
  });
  if (error) throw new Error(`error_events insert failed: ${error.message}`);
  return json({ ok: true });
});
