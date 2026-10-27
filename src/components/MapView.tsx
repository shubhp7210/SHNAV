import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { hasWebGL } from "@/lib/webgl";
import Map3D, { type Pt } from "@/components/Map3D";
import MapLoading from "@/components/MapLoading";
import type { CameraMode } from "@/lib/cesium/cameraModes";
import type { InitialView } from "@/lib/cesium/engine";

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
  /** Fixed starting camera (Cesium). Routes are not auto-framed when set. */
  initialView?: InitialView;
  /** Canvas-only: loop the demo aircraft along routes (ambient views). */
  animate?: boolean;
  /** Canvas-only: slow auto-rotate. */
  rotate?: boolean;
  interactive?: boolean;
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
  const { animate, rotate, onReady, ...shared } = props;
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
          <CesiumMap {...shared} onReady={onReady} />
        </Suspense>
      ) : (
        <MapLoading />
      )}
    </div>
  );
}

export type { Pt };
