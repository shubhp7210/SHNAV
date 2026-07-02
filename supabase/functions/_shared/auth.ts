import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthedUser {
  id: string;
  email?: string;
}

/**
 * Validates the JWT in the Authorization header and returns the authenticated user.
 * Throws a Response (401) if the token is missing or invalid.
 * Callers must catch Response objects and return them directly:
 *
 *   try {
 *     const user = await requireUserAuth(req);
 *   } catch (err) {
 *     if (err instanceof Response) return err;
 *     throw err;
 *   }
 */
export async function requireUserAuth(req: Request): Promise<AuthedUser> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Response(
      JSON.stringify({ error: "Missing or invalid Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  const token = authHeader.slice(7);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const client = createClient(supabaseUrl, anonKey);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    throw new Response(
      JSON.stringify({ error: "Invalid or expired token" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return { id: data.user.id, email: data.user.email };
}

/**
 * Validates that the request carries the internal function secret.
 * Throws a Response (403) if the secret is absent or wrong.
 * Use in cron/system functions that must never be called by end users.
 * Set INTERNAL_FUNCTION_SECRET in Supabase Vault / project env vars.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function requireInternalSecret(req: Request): void {
  const expected = Deno.env.get("INTERNAL_FUNCTION_SECRET");
  const provided = req.headers.get("X-Internal-Secret");
  if (!expected || !provided || !constantTimeEqual(provided, expected)) {
    throw new Response(
      JSON.stringify({ error: "Forbidden" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
}
