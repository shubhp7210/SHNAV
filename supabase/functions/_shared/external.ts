// One loader + evaluator for real external airspace data, so trajectory
// analysis, the route optimizer and the decision engine all judge a route
// against the SAME validated, stored observations (never ad-hoc fetches).
//
// Time alignment: only records valid during the flight's departure window are
// used; live ADS-B is used only when the departure is within 20 minutes (a
// snapshot says nothing about traffic later); METARs only within 90 minutes
// and never from after "now". Planning code has no access to past outcomes.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type AdvisoryHit, type AdvisoryRow, type LatLon, type LiveTrafficHit, type RestrictionHit, type RestrictionRow,
  type TrafficRow, nearbyLiveTraffic, routeAdvisoryHits, routeRestrictionHits,
} from "./airspace.ts";

const SAFETY_SOURCES = ["faa-tfr", "awc-airsigmet", "awc-gairmet", "nws-alerts", "awc-metar"];
export const LIVE_TRAFFIC_HORIZON_MIN = 20;

export interface SourceStatus { id: string; name: string; freshness: string; last_success_at: string | null; last_data_at: string | null }
export interface ExternalData {
  restrictions: RestrictionRow[]; advisories: AdvisoryRow[]; traffic: TrafficRow[];
  sources: SourceStatus[]; loadedAt: string; errors: string[];
}

export async function loadExternal(admin: SupabaseClient, startMs: number, endMs: number): Promise<ExternalData> {
  const from = new Date(startMs).toISOString(), to = new Date(endMs).toISOString();
  const now = Date.now();
  const liveWanted = startMs - now <= LIVE_TRAFFIC_HORIZON_MIN * 60_000;
  const [r, a, t, s] = await Promise.all([
    admin.from("airspace_restrictions_current")
      .select("id, external_id, name, restriction_type, valid_from, valid_to, alt_low_ft, alt_high_ft, areas, quality, quality_flags, fetched_at")
      .limit(500),   // regional + current only; time overlap is checked per route
    admin.from("wx_advisories")
      .select("id, kind, external_id, hazard, severity, valid_from, valid_to, alt_low_ft, alt_high_ft, geometry_type, polygon, headline, quality")
      .gte("valid_to", from).lte("valid_from", to).neq("quality", "rejected").limit(500),
    liveWanted
      ? admin.from("traffic_observations")
          .select("icao24, callsign, observed_at, lat, lon, baro_alt_m, geo_alt_m, on_ground, velocity_ms, track_deg, quality")
          .gte("observed_at", new Date(now - 3 * 60_000).toISOString()).limit(2000)
      : Promise.resolve({ data: [], error: null }),
    admin.from("data_source_status").select("id, name, freshness, last_success_at, last_data_at"),
  ]);
  const errors = [r, a, t, s].filter((x) => x.error).map((x) => x.error!.message);
  return {
    restrictions: (r.data ?? []) as RestrictionRow[], advisories: (a.data ?? []) as AdvisoryRow[],
    traffic: (t.data ?? []) as TrafficRow[], sources: (s.data ?? []) as SourceStatus[],
    loadedAt: new Date(now).toISOString(), errors,
  };
}

export interface ExternalEvaluation {
  restrictions: RestrictionHit[];
  advisories: AdvisoryHit[];
  live_traffic: { applicable: boolean; reason: string; hits: LiveTrafficHit[] };
  data_status: { ok: boolean; problems: string[]; sources: SourceStatus[]; checked_at: string };
}

export function evaluateExternal(path: LatLon[], band: string, startMs: number, endMs: number, ext: ExternalData): ExternalEvaluation {
  const nowMs = Date.parse(ext.loadedAt);
  const applicable = startMs - nowMs <= LIVE_TRAFFIC_HORIZON_MIN * 60_000 && endMs >= nowMs - 30 * 60_000;
  const opensky = ext.sources.find((s) => s.id === "opensky");
  const problems: string[] = [...ext.errors.map((e) => `query failed: ${e}`)];
  for (const id of SAFETY_SOURCES) {
    const s = ext.sources.find((x) => x.id === id);
    if (!s) problems.push(`${id}: not configured`);
    else if (s.freshness === "never" || s.freshness === "stale" || s.freshness === "disabled") problems.push(`${s.name}: ${s.freshness}`);
  }
  return {
    restrictions: path.length >= 2 ? routeRestrictionHits(path, startMs, endMs, band, ext.restrictions) : [],
    advisories: path.length >= 2 ? routeAdvisoryHits(path, startMs, endMs, band, ext.advisories) : [],
    live_traffic: applicable
      ? {
          applicable: true,
          reason: opensky && opensky.freshness !== "never"
            ? `ADS-B snapshot ${opensky.last_data_at ?? "unknown"}; aircraft ≤900 m within 2 km of route`
            : "ADS-B feed has not delivered data yet",
          hits: nearbyLiveTraffic(path, ext.traffic, nowMs),
        }
      : { applicable: false, reason: `departure is more than ${LIVE_TRAFFIC_HORIZON_MIN} min away — a live snapshot cannot predict traffic then`, hits: [] },
    data_status: { ok: problems.length === 0, problems, sources: ext.sources, checked_at: ext.loadedAt },
  };
}

/** Score impact of external findings, applied identically everywhere. */
export function externalPenalty(e: ExternalEvaluation): number {
  let p = 0;
  if (e.restrictions.length) p += 60;
  for (const a of e.advisories) p += a.severity === "high" ? 30 : a.severity === "moderate" ? 10 : 3;
  for (const t of e.live_traffic.hits) p += t.severity === "high" ? 10 : t.severity === "moderate" ? 5 : 0;
  return Math.min(80, p);
}
