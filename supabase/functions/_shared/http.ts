// One request wrapper for every edge function: CORS (incl. on 4xx thrown by
// auth/validation helpers — previously those lacked CORS headers, so the
// browser hid the real error), a service-role client, uniform JSON errors,
// error capture and usage metering.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "./constants.ts";
import { countCall, flushUsage, reportError } from "./log.ts";

export interface Ctx {
  req: Request;
  admin: SupabaseClient;
  cors: Record<string, string>;
  json: (payload: unknown, status?: number) => Response;
  /** Attach the authenticated user so captured errors are attributable. */
  setUser: (id: string) => void;
}

export function httpError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

export function serve(fn: string, impl: (ctx: Ctx) => Promise<Response>): void {
  Deno.serve(async (req) => {
    const cors = getCorsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { ...cors, "Content-Type": "application/json" } });
    let userId: string | null = null;
    countCall("edge-functions");
    try {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await impl({ req, admin, cors, json, setUser: (id) => { userId = id; } });
    } catch (err) {
      if (err instanceof Response) {
        // Thrown 4xx from auth/validation: re-emit with CORS headers.
        const headers = new Headers(err.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(err.body, { status: err.status, headers });
      }
      await reportError(admin, fn, err, { method: req.method }, userId);
      return json({ error: "Internal server error" }, 500);
    } finally {
      await flushUsage(admin);
    }
  });
}

export type { SupabaseClient };
