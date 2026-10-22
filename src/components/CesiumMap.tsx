import { useEffect, useRef, useState } from "react";
import {
  CesiumWidget, Cartesian3, Color, BoundingSphere, HeadingPitchRange,
  GroundPolylinePrimitive, GroundPolylineGeometry, GeometryInstance,
  PolylineMaterialAppearance, Material, PointPrimitiveCollection, PointPrimitive,
  Math as CMath,
} from "cesium";
import { createEngine, toCartesian } from "@/lib/cesium/engine";
import { CameraController, type CameraMode } from "@/lib/cesium/cameraModes";
import type { Pt } from "@/components/Map3D";

export interface CesiumMapProps {
  routes: Pt[][];       // routes[0] = active flight
  progress?: number;    // 0..1 along routes[0]
  heading?: number;     // vehicle heading (deg) from telemetry; omit if unknown
  speedKmh?: number;    // vehicle speed — feeds Forward-Flight look-ahead
  cameraMode?: CameraMode; // controls the tracking camera (monitoring view)
  interactive?: boolean;
  color?: string;
  label?: string;
  onReady?: (info: { geoDataLoaded: boolean; warnings: string[] }) => void;
}

const ACCENT = "#FF3157";        // coral-red active route
const OVERVIEW_BLUE = "#3049A4"; // cobalt overview arc

function along(poly: Pt[], t: number): Pt {
  if (poly.length === 0) return { lat: 0, lng: 0 };
  if (poly.length === 1) return poly[0];
  const tt = Math.max(0, Math.min(1, t));
  const f = tt * (poly.length - 1);
  const i = Math.min(Math.floor(f), poly.length - 2);
  const k = f - i;
  return {
    lat: poly[i].lat + (poly[i + 1].lat - poly[i].lat) * k,
    lng: poly[i].lng + (poly[i + 1].lng - poly[i].lng) * k,
  };
}

/**
 * Premium Cesium 3D map (CesiumWidget + primitives — no entity system / no eval).
 * WebGL-only: callers gate on hasWebGL() and fall back to the canvas <Map3D/>.
 * Routes are CLAMPED TO GROUND — the optimizer's waypoints carry no altitude, so
 * no vertical geometry is invented.
 */
export default function CesiumMap({
  routes, progress, heading, speedKmh = 0, cameraMode, interactive = true, color = ACCENT, label, onReady,
}: CesiumMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<CesiumWidget | null>(null);
  const vehicleRef = useRef<PointPrimitive | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Mount / unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    const el = containerRef.current;
    if (!el) return;

    createEngine(el)
      .then(({ widget, geoDataLoaded, warnings }) => {
        if (disposed) { widget.destroy(); return; }
        widgetRef.current = widget;
        widget.scene.screenSpaceCameraController.enableInputs = interactive;
        onReady?.({ geoDataLoaded, warnings });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "3D map failed to initialize."));

    return () => {
      disposed = true;
      cameraRef.current?.dispose();
      cameraRef.current = null;
      const w = widgetRef.current;
      if (w && !w.isDestroyed()) w.destroy();
      widgetRef.current = null;
      vehicleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Draw routes + pins ─────────────────────────────────────────────────────
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || widget.isDestroyed() || routes.length === 0) return;
    const scene = widget.scene;
    const groundPrims: GroundPolylinePrimitive[] = [];
    const points = scene.primitives.add(new PointPrimitiveCollection());
    const allPositions: Cartesian3[] = [];

    routes.forEach((poly, ri) => {
      if (poly.length < 2) return;
      const active = ri === 0;
      const flat = poly.flatMap((p) => [p.lng, p.lat]);
      const positions = Cartesian3.fromDegreesArray(flat);
      allPositions.push(...positions);

      const prim = new GroundPolylinePrimitive({
        geometryInstances: new GeometryInstance({
          geometry: new GroundPolylineGeometry({ positions, width: active ? 8 : 3 }),
        }),
        appearance: new PolylineMaterialAppearance({
          material: active
            ? Material.fromType("PolylineGlow", { color: Color.fromCssColorString(color), glowPower: 0.25 })
            : Material.fromType("Color", { color: Color.fromCssColorString(OVERVIEW_BLUE).withAlpha(0.6) }),
        }),
      });
      scene.groundPrimitives.add(prim);
      groundPrims.push(prim);

      if (active) {
        const pin = (p: Pt, c: string) => points.add({
          position: toCartesian(p.lat, p.lng, 0),
          pixelSize: 16, color: Color.fromCssColorString(c),
          outlineColor: Color.WHITE, outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, // always visible over terrain
        });
        pin(poly[0], color);
        pin(poly[poly.length - 1], "#fbbf24");
      }
    });

    cameraRef.current?.setRoute(routes[0] ?? []);

    // One-time framing when NOT actively tracking (the CameraController owns the
    // camera once telemetry starts, so don't fight it here).
    if (allPositions.length > 0 && !cameraRef.current) {
      const sphere = BoundingSphere.fromPoints(allPositions);
      widget.camera.flyToBoundingSphere(sphere, {
        duration: 1.2,
        offset: new HeadingPitchRange(0, CMath.toRadians(-35), sphere.radius * 3.2),
      });
    }

    return () => {
      if (widget.isDestroyed()) return;
      groundPrims.forEach((p) => scene.groundPrimitives.remove(p));
      scene.primitives.remove(points); // also destroys the vehicle point
      vehicleRef.current = null;
    };
  }, [routes, color]);

  // ── Vehicle marker + Follow camera (driven by progress/heading) ────────────
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || widget.isDestroyed() || progress == null) return;
    const poly = routes[0];
    if (!poly || poly.length < 2) return;
    const pos = along(poly, progress);

    // Lazily create the vehicle point in its own collection.
    if (!vehicleRef.current) {
      const coll = widget.scene.primitives.add(new PointPrimitiveCollection());
      vehicleRef.current = coll.add({
        position: toCartesian(pos.lat, pos.lng, 0),
        pixelSize: 15, color: Color.fromCssColorString(color),
        outlineColor: Color.WHITE, outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    } else {
      vehicleRef.current.position = toCartesian(pos.lat, pos.lng, 0);
    }

    // Smooth multi-mode camera controller (created lazily once tracking starts).
    if (!cameraRef.current) {
      cameraRef.current = new CameraController(widget);
      cameraRef.current.setRoute(poly);
      cameraRef.current.setMode(cameraMode ?? "follow");
    }
    const next = along(poly, Math.min(1, progress + 0.04));
    const hdg = heading ?? CMath.toDegrees(Math.atan2(next.lng - pos.lng, next.lat - pos.lat));
    cameraRef.current.setVehicle({ lat: pos.lat, lng: pos.lng, heading: hdg, speedKmh, ts: performance.now() });
  }, [progress, heading, speedKmh, cameraMode, routes, color]);

  // Apply camera-mode changes from the cockpit.
  useEffect(() => {
    if (cameraMode) cameraRef.current?.setMode(cameraMode);
  }, [cameraMode]);

  if (error) {
    return (
      <div style={{ position: "absolute", inset: 0 }} className="flex items-center justify-center bg-zinc-950 text-white/60 text-sm">
        3D map unavailable — {error}
      </div>
    );
  }
  return <div ref={containerRef} aria-label={label ?? "3D map"} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}
