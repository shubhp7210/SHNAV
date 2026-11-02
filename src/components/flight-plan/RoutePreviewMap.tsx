import { useMemo, useState } from "react";
import { Crosshair, LocateFixed } from "lucide-react";
import MapView from "@/components/MapView";
import type { FrameRequest } from "@/components/CesiumMap";
import type { FlightPlanData } from "@/pages/FlightPlan";
import { MANHATTAN_VIEW, bandHeight, type Pt } from "@/lib/geo/region";
import { candidateRoutes, locationCoords } from "@/lib/geo/coords";

const placeName = (loc: string) => (loc ?? "").replace(/\s*@\s*-?\d+\.?\d*\s*,\s*-?\d+\.?\d*\s*$/, "");

/**
 * Clearance-step 3D preview: the selected route as a raised corridor, with every
 * alternate the optimizer evaluated drawn as a dashed ground track. Opens on
 * Manhattan; "Frame route" flies to the real route without altering it.
 */
export default function RoutePreviewMap({ data }: { data: FlightPlanData }) {
  const [frame, setFrame] = useState<FrameRequest>({ key: 0 });
  const selectedId = data.selectedRouteId ?? data.atmEngines.flightDecision?.route_id ?? null;

  const routes = useMemo<Pt[][]>(() => {
    const candidates = candidateRoutes(data.routeData, selectedId);
    if (candidates.length > 0) return candidates;
    // No optimizer output yet: show the filed origin → destination leg if both
    // ends resolve to real coordinates.
    const a = locationCoords(data.origin), b = locationCoords(data.destination);
    return a && b ? [[a, b]] : [];
  }, [data.routeData, selectedId, data.origin, data.destination]);

  const band = (data.altitudeBand || "low").toUpperCase();
  const height = bandHeight(data.altitudeBand);
  const alternates = Math.max(0, routes.length - 1);

  return (
    <div className="absolute inset-0">
      <MapView
        routes={routes}
        initialView={MANHATTAN_VIEW}
        corridorHeight={routes.length ? height : undefined}
        endpointLabels={[placeName(data.origin), placeName(data.destination)]}
        frame={frame}
        interactive
        label="3D route preview"
      />
      <div className="absolute inset-0 pointer-events-none map-vignette" />

      <div className="absolute top-3 left-3 right-3 flex items-start justify-between gap-2 pointer-events-none">
        <div className="glass-panel rounded-lg px-3 py-2">
          <p className="label-caps">Route preview</p>
          <p className="text-xs text-foreground/85 mt-0.5 tabular">
            {routes.length === 0 ? "Awaiting route" : `${band} band · ${alternates} alternate${alternates === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={() => setFrame((f) => ({ key: f.key + 1 }))}
            disabled={routes.length === 0}
            className="rounded-lg h-9 px-3.5 flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground shadow-[0_8px_24px_-8px_hsl(var(--primary)/0.8)] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <Crosshair className="w-3.5 h-3.5" /> Frame route
          </button>
          <button
            onClick={() => setFrame((f) => ({ key: f.key + 1, view: MANHATTAN_VIEW }))}
            className="glass-panel rounded-lg h-9 w-9 flex items-center justify-center text-foreground/80 hover:text-foreground transition-colors"
            title="Reset to Manhattan" aria-label="Reset view to Manhattan"
          >
            <LocateFixed className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="absolute bottom-3 left-3 right-3 pointer-events-none">
        <div className="glass-panel rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-foreground/75">
          <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-primary" />Selected corridor</span>
          {alternates > 0 && <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded border-t border-dashed border-signal" />Alternates</span>}
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-caution" />Destination</span>
          <span className="text-foreground/45 basis-full sm:basis-auto">
            Corridor drawn at nominal {band} band (~{height} m) — illustrative
          </span>
        </div>
      </div>
    </div>
  );
}
