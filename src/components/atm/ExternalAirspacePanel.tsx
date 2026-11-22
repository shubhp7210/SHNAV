import { AlertTriangle, Ban, CheckCircle, CloudLightning, Plane, Radio } from "lucide-react";
import type { AdvisoryHit, ExternalDataStatus, LiveTrafficCheck, RestrictionHit } from "@/lib/routeTypes";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "until further notice");
const sevClass = (s: string) =>
  s === "high" ? "bg-destructive/15 text-destructive border-destructive/30"
    : s === "moderate" ? "bg-caution/15 text-caution border-caution/30"
    : "bg-muted text-muted-foreground border-border";

/** Real-data checks for one route: FAA TFRs, SIGMET/AIRMET/NWS advisories,
 *  live ADS-B traffic, and the freshness of every source used. Every empty
 *  state says what was checked; nothing is shown as "clear" unchecked. */
export default function ExternalAirspacePanel({ restrictions, advisories, liveTraffic, dataStatus }: {
  restrictions?: RestrictionHit[]; advisories?: AdvisoryHit[]; liveTraffic?: LiveTrafficCheck | null; dataStatus?: ExternalDataStatus | null;
}) {
  if (!dataStatus) {
    return (
      <div className="well rounded-lg p-4 text-xs text-muted-foreground flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-caution" /> TFR, advisory and live-traffic data were not checked for this route.
      </div>
    );
  }
  const tfrSrc = dataStatus.sources.find((s) => s.id === "faa-tfr");
  const tfrFresh = tfrSrc?.freshness === "fresh" || tfrSrc?.freshness === "degraded";
  const relevantAdv = (advisories ?? []).filter((a) => a.severity !== "low");

  return (
    <div className="well rounded-lg p-4 space-y-4">
      <p className="text-xs font-mono tracking-widest uppercase text-muted-foreground">Airspace &amp; live data</p>

      {/* TFRs */}
      <div>
        <p className="text-[11px] font-mono text-muted-foreground mb-1.5 flex items-center gap-1.5"><Ban className="w-3.5 h-3.5" /> FAA temporary flight restrictions</p>
        {restrictions && restrictions.length > 0 ? restrictions.map((r) => (
          <div key={r.notam} className={`rounded-md border px-2.5 py-2 mb-1.5 text-xs ${sevClass("high")}`}>
            <span className="font-mono font-semibold">NOTAM {r.notam}</span>{r.name ? ` · ${r.name}` : ""}{r.type ? ` · ${r.type}` : ""}
            <div className="text-[11px] opacity-90 mt-0.5">
              {fmt(r.valid_from)} → {fmt(r.valid_to)} · {r.alt_low_ft ?? 0}–{r.alt_high_ft ?? "?"} ft
              {r.geometry_approximated && " · boundary arcs approximated"}
            </div>
          </div>
        )) : tfrFresh ? (
          <p className="text-xs text-success flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" /> Route enters no active TFR in the flight window</p>
        ) : (
          <p className="text-xs text-caution flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> TFR feed is {tfrSrc?.freshness ?? "unavailable"} — restrictions could not be confirmed</p>
        )}
      </div>

      {/* Advisories */}
      <div>
        <p className="text-[11px] font-mono text-muted-foreground mb-1.5 flex items-center gap-1.5"><CloudLightning className="w-3.5 h-3.5" /> SIGMET / AIRMET / NWS advisories</p>
        {relevantAdv.length > 0 ? relevantAdv.map((a) => (
          <div key={a.external_id} className={`rounded-md border px-2.5 py-1.5 mb-1.5 text-xs ${sevClass(a.severity)}`}>
            <span className="font-mono font-semibold">{a.kind}</span>{a.hazard ? ` · ${a.hazard}` : ""}{a.headline ? ` · ${a.headline}` : ""}
            <span className="text-[11px] opacity-80"> · until {fmt(a.valid_to)}</span>
          </div>
        )) : (
          <p className="text-xs text-muted-foreground">No significant advisory covers the route{(advisories?.length ?? 0) > 0 ? ` (${advisories!.length} minor)` : ""}.</p>
        )}
      </div>

      {/* Live ADS-B */}
      <div>
        <p className="text-[11px] font-mono text-muted-foreground mb-1.5 flex items-center gap-1.5"><Radio className="w-3.5 h-3.5" /> Live ADS-B traffic (OpenSky)</p>
        {!liveTraffic || !liveTraffic.applicable ? (
          <p className="text-xs text-muted-foreground">{liveTraffic?.reason ?? "Not evaluated."}</p>
        ) : liveTraffic.hits.length === 0 ? (
          <p className="text-xs text-muted-foreground">No low-altitude aircraft within 2 km of the route right now. <span className="opacity-70">{liveTraffic.reason}</span></p>
        ) : (
          <div className="space-y-1">
            {liveTraffic.hits.slice(0, 6).map((h) => (
              <div key={h.icao24} className="flex items-center gap-2 text-xs">
                <Plane className="w-3.5 h-3.5 text-signal shrink-0" />
                <span className="font-mono">{h.callsign ?? h.icao24}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-mono ${sevClass(h.severity)}`}>{h.severity}</span>
                <span className="text-muted-foreground">{h.distance_m} m from route · {h.altitude_m != null ? `${h.altitude_m} m alt` : "alt n/a"} · {h.age_s}s ago</span>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">Live snapshot only — see-and-avoid still applies.</p>
          </div>
        )}
      </div>

      {/* Freshness */}
      <div className="border-t border-border/30 pt-2">
        {!dataStatus.ok && (
          <p className="text-[11px] text-caution mb-1">Degraded: {dataStatus.problems.join(" · ")}</p>
        )}
        <SourceBadges sources={dataStatus.sources} />
      </div>
    </div>
  );
}

const DOT: Record<string, string> = { fresh: "bg-success", degraded: "bg-caution", stale: "bg-destructive", never: "bg-muted-foreground", disabled: "bg-muted-foreground", on_demand: "bg-signal" };

export function SourceBadges({ sources }: { sources: { id: string; name: string; freshness: string; last_success_at: string | null }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((s) => (
        <span key={s.id} title={`${s.name} — ${s.freshness}${s.last_success_at ? `, last ok ${new Date(s.last_success_at).toLocaleTimeString()}` : ""}`}
          className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground border border-border/50 rounded-full px-2 py-0.5">
          <span className={`w-1.5 h-1.5 rounded-full ${DOT[s.freshness] ?? "bg-muted-foreground"}`} />
          {s.id}
        </span>
      ))}
    </div>
  );
}
