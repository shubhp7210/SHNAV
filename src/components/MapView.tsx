import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { hasWebGL } from "@/lib/webgl";
import Map3D from "@/components/Map3D";
import type { Pt, TargetView } from "@/lib/geo/region";
import type { FrameRequest } from "@/components/CesiumMap";
import MapLoading from "@/components/MapLoading";
import type { CameraMode } from "@/lib/cesium/cameraModes";

// Cesium is a multi-MB chunk: load it only when a WebGL map is actually about
// to be shown, never on the critical path of a page.
const CesiumMap = lazy(() => import("@/components/CesiumMap"));

// Single entry point for every map in the app. Picks the premium Cesium 3D
// renderer when WebGL is available, else the WebGL-free canvas renderer. Exactly
// one renderer mounts — they never run simultaneously.
export interface MapViewProps {
  routes: Pt[][];
  progress?: number;
  heading?: number;
  speedKmh?: number;
  cameraMode?: CameraMode;
  /** Starting camera. Defaults to Manhattan; routes are never auto-framed. */
  initialView?: TargetView;
  /** Draw routes[0] as a raised corridor at this display height (m). */
  corridorHeight?: number;
  /** Fly to fit routes when `key` changes (Cesium). */
  frame?: FrameRequest;
  /** Labels for routes[0] origin/destination (Cesium). */
  endpointLabels?: [string, string];
  /** Loop clearly-simulated aircraft along routes (ambient views only). */
  animate?: boolean;
  /** Slow cinematic orbit / auto-rotate until the user interacts. */
  rotate?: boolean;
  interactive?: boolean;
  /** false = mouse wheel scrolls the page instead of zooming the map. */
  wheelZoom?: boolean;
  color?: string;
  label?: string;
  onReady?: (info: { geoDataLoaded: boolean; warnings: string[] }) => void;
}

/** True once `ref` comes within `margin` of the viewport (latched). */
function useNearViewport(ref: React.RefObject<HTMLElement>, margin = "300px"): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setNear(true); io.disconnect(); }
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin, near]);
  return near;
}

export default function MapView(props: MapViewProps) {
  const { animate, rotate, onReady, wheelZoom, ...shared } = props;
  const [webgl] = useState(() => hasWebGL());
  const hostRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(hostRef);

  if (!webgl) {
    // Canvas fallback (e.g. browsers with WebGL disabled).
    return (
      <Map3D
        routes={shared.routes}
        progress={shared.progress}
        interactive={shared.interactive}
        color={shared.color}
        label={shared.label}
        animate={animate}
        rotate={rotate}
      />
    );
  }
  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
      {near ? (
        <Suspense fallback={<MapLoading />}>
          <CesiumMap {...shared} wheelZoom={wheelZoom} simulate={animate} orbit={rotate} onReady={onReady} />
        </Suspense>
      ) : (
        <MapLoading />
      )}
    </div>
  );
}

export type { Pt, FrameRequest };
