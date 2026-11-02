// Manual trigger for the nightly fleet-pattern refresh. The refresh itself is
// set-based SQL (public.refresh_fleet_route_patterns) scheduled by pg_cron at
// 03:15 UTC, so it no longer depends on anything calling this endpoint (nothing
// ever did — the job had never run). Requires X-Internal-Secret.
import { serve } from "../_shared/http.ts";
import { requireInternalSecret } from "../_shared/auth.ts";

serve("background-analyzer", async ({ req, admin, json }) => {
  requireInternalSecret(req);
  const { data, error } = await admin.rpc("refresh_fleet_route_patterns");
  if (error) throw new Error(`refresh_fleet_route_patterns failed: ${error.message}`);
  return json(data);
});
