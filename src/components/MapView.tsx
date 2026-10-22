import { useState } from "react";
import { hasWebGL } from "@/lib/webgl";
import Map3D, { type Pt } from "@/components/Map3D";
import CesiumMap from "@/components/CesiumMap";
import type { CameraMode } from "@/lib/cesium/cameraModes";

// Single entry point for every map in the app. Picks the premium Cesium 3D
// renderer when WebGL is available, else the WebGL-free canvas renderer. Exactly
// one renderer mounts — they never run simultaneously.
export interface MapViewProps {
  routes: Pt[][];
  progress?: number;
  heading?: number;
  speedKmh?: number;
  cameraMode?: CameraMode;
  /** Canvas-only: loop the demo aircraft along routes (ambient views). */
  animate?: boolean;
  /** Canvas-only: slow auto-rotate. */
  rotate?: boolean;
  interactive?: boolean;
  color?: string;
  label?: string;
  onReady?: (info: { geoDataLoaded: boolean; warnings: string[] }) => void;
}

export default function MapView(props: MapViewProps) {
  const { animate, rotate, onReady, ...shared } = props;
  const [webgl] = useState(() => hasWebGL());

  if (webgl) {
    return <CesiumMap {...shared} onReady={onReady} />;
  }
  // Canvas fallback (e.g. this environment, where WebGL is disabled).
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

export type { Pt };
