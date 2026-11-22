// Live airspace overlays from the stored, validated observations: current FAA
// TFRs in the NYC region and the latest ADS-B fix per aircraft (≤3 min old,
// airborne). Refreshes every 60 s. Never invents data: empty = nothing reported.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { MapOverlays } from "@/components/CesiumMap";

export interface LiveAirspace {
  overlays: MapOverlays;
  tfrs: { id: string; name: string; valid_to: string | null }[];
  aircraftCount: number;
  trafficAsOf: string | null;
  loaded: boolean;
  error: string | null;
}

const EMPTY: LiveAirspace = { overlays: { zones: [], aircraft: [] }, tfrs: [], aircraftCount: 0, trafficAsOf: null, loaded: false, error: null };

export function useLiveAirspace(enabled = true): LiveAirspace {
  const [state, setState] = useState<LiveAirspace>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      const since = new Date(Date.now() - 3 * 60_000).toISOString();
      const now = new Date().toISOString();
      const [r, t] = await Promise.all([
        supabase.from("airspace_restrictions_current").select("external_id, name, valid_from, valid_to, areas").limit(200),
        supabase.from("traffic_observations").select("icao24, callsign, observed_at, lat, lon, baro_alt_m, geo_alt_m, on_ground, quality")
          .gte("observed_at", since).eq("on_ground", false).neq("quality", "rejected").order("observed_at", { ascending: false }).limit(1500),
      ]);
      if (cancelled) return;
      const active = (r.data ?? []).filter((z) => (!z.valid_to || z.valid_to >= now) && (!z.valid_from || z.valid_from <= new Date(Date.now() + 6 * 3600e3).toISOString()));
      const zones = active.map((z) => ({
        id: z.external_id,
        label: `TFR ${z.external_id}`,
        rings: ((z.areas ?? []) as { points: { lat: number; lon: number }[] }[]).map((a) => a.points.map((p) => ({ lat: p.lat, lng: p.lon }))),
      }));
      const latest = new Map<string, NonNullable<typeof t.data>[number]>();
      for (const a of t.data ?? []) if (!latest.has(a.icao24)) latest.set(a.icao24, a);
      const aircraft = [...latest.values()].map((a) => ({
        id: a.icao24, label: a.callsign || a.icao24, lat: a.lat, lng: a.lon, altM: a.geo_alt_m ?? a.baro_alt_m,
      }));
      setState({
        overlays: { zones, aircraft },
        tfrs: active.map((z) => ({ id: z.external_id, name: z.name ?? z.external_id, valid_to: z.valid_to })),
        aircraftCount: aircraft.length,
        trafficAsOf: (t.data ?? [])[0]?.observed_at ?? null,
        loaded: true,
        error: r.error?.message ?? t.error?.message ?? null,
      });
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);
  return state;
}
