import { useEffect, useMemo, useRef, useState } from "react";
import {
  CesiumWidget, Cartesian3, Color, BoundingSphere, HeadingPitchRange,
  GroundPolylinePrimitive, GroundPolylineGeometry, GeometryInstance,
  PolylineMaterialAppearance, Material, PointPrimitiveCollection, PointPrimitive,
  Matrix4, Math as CMath,
} from "cesium";
import { createEngine, toCartesian, type InitialView, type EngineResult } from "@/lib/cesium/engine";
import { CameraController, type CameraMode } from "@/lib/cesium/cameraModes";
import { regionFor, routesKey } from "@/lib/geo/region";
import type { Pt } from "@/components/Map3D";
import MapLoading from "@/components/MapLoading";

export interface CesiumMapProps {
  routes: Pt[][];       // routes[0] = active flight
  progress?: number;    // 0..1 along routes[0]
  heading?: number;     // vehicle heading (deg) from telemetry; omit if unknown
  speedKmh?: number;    // vehicle speed — feeds Forward-Flight look-ahead
  cameraMode?: CameraMode; // controls the tracking camera (monitoring view)
  /** Fixed starting camera. When set, routes are not auto-framed on first draw. */
  initialView?: InitialView;
  interactive?: boolean;
  color?: string;
  label?: string;
  onReady?: (info: { geoDataLoaded: boolean; warnings: string[] }) => void;
}

const ACCENT = "#FF3157";        // coral-red active route
const OVERVIEW_BLUE = "#3049A4"; // cobalt overview arc
const FIRST_FRAME_TIMEOUT_MS = 10_000;

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
  routes, progress, heading, speedKmh = 0, cameraMode, initialView, interactive = true,
  color = ACCENT, label, onReady,
}: CesiumMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EngineResult | null>(null);
  const vehicleCollRef = useRef<PointPrimitiveCollection | null>(null);
  const vehicleRef = useRef<PointPrimitive | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const framedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Callers routinely pass a freshly built routes array every render; key effects
  // on the route *content* so geometry is only rebuilt when it actually changes.
  const key = routesKey(routes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRoutes = useMemo(() => routes, [key]);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // ── Mount / unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let engine: EngineResult;
    try {
      engine = createEngine(el, initialView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "3D map failed to initialize.");
      return;
    }
    engineRef.current = engine;
    const { widget } = engine;
    widget.scene.screenSpaceCameraController.enableInputs = interactive;
    // Dev-only handle for the headless map test harness.
    if (import.meta.env.DEV) (window as unknown as { __shnavMap?: CesiumWidget }).__shnavMap = widget;
    if (initialView) framedRef.current = true;

    // Real WebGL failures (context lost, shader errors) — show them honestly.
    const offError = widget.scene.renderError.addEventListener((_s, err) => {
      console.error("Cesium render error:", err);
      setError("the graphics context was lost. Reload the page to retry.");
    });

    // Loading indicator: hide once the visible tiles have arrived (or after a
    // timeout, so a slow tile server never leaves the overlay up forever).
    const done = () => { if (!disposed) setLoading(false); };
    const timer = window.setTimeout(done, FIRST_FRAME_TIMEOUT_MS);
    const offTiles = widget.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
      if (queued === 0 && widget.scene.globe.tilesLoaded) done();
    });

    // Pause the render loop entirely while the map is off-screen.
    const io = new IntersectionObserver(([entry]) => {
      if (widget.isDestroyed()) return;
      widget.useDefaultRenderLoop = entry.isIntersecting;
      if (entry.isIntersecting) widget.scene.requestRender();
    });
    io.observe(el);

    setReady(true);
    engine.layers.then((info) => {
      if (!disposed) onReadyRef.current?.(info);
    });

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      io.disconnect();
      offError();
      offTiles();
      cameraRef.current?.dispose();
      cameraRef.current = null;
      if (!widget.isDestroyed()) widget.destroy(); // also destroys all primitives
      engineRef.current = null;
      vehicleCollRef.current = null;
      vehicleRef.current = null;
      framedRef.current = false;
      setReady(false);
    };
    // Mount-once by design: props after mount are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const w = engineRef.current?.widget;
    if (!ready || !w || w.isDestroyed()) return;
    if (!cameraRef.current || cameraRef.current.getMode() === "free") {
      w.scene.screenSpaceCameraController.enableInputs = interactive;
    }
  }, [ready, interactive]);

  // ── Draw routes + pins (only when route content changes) ──────────────────
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || engine.widget.isDestroyed()) return;
    const widget = engine.widget;
    const scene = widget.scene;

    // Region = North America, widened if a route genuinely leaves it.
    engine.setBounds(regionFor(stableRoutes));

    const groundPrims: GroundPolylinePrimitive[] = [];
    const points = scene.primitives.add(new PointPrimitiveCollection());
    const allPositions: Cartesian3[] = [];

    stableRoutes.forEach((poly, ri) => {
      if (poly.length < 2) return;
      const active = ri === 0;
      const positions = Cartesian3.fromDegreesArray(poly.flatMap((p) => [p.lng, p.lat]));
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

    cameraRef.current?.setRoute(stableRoutes[0] ?? []);

    // Frame the routes when NOT actively tracking (the CameraController owns the
    // camera once telemetry starts). First framing is instant — no fly-in from
    // space; later route changes ease over.
    if (allPositions.length > 0 && !cameraRef.current) {
      const sphere = BoundingSphere.fromPoints(allPositions);
      const offset = new HeadingPitchRange(0, CMath.toRadians(-35), Math.max(1500, sphere.radius * 3.2));
      if (!framedRef.current) {
        widget.camera.viewBoundingSphere(sphere, offset);
        widget.camera.lookAtTransform(Matrix4.IDENTITY); // release so the user can pan
        framedRef.current = true;
      } else {
        widget.camera.flyToBoundingSphere(sphere, { duration: 0.8, offset });
      }
    }
    scene.requestRender();

    return () => {
      if (widget.isDestroyed()) return;
      groundPrims.forEach((p) => scene.groundPrimitives.remove(p));
      scene.primitives.remove(points);
      scene.requestRender();
    };
  }, [ready, stableRoutes, color]);

  // ── Vehicle marker + tracking camera (driven by progress/heading) ──────────
  useEffect(() => {
    const widget = engineRef.current?.widget;
    if (!ready || !widget || widget.isDestroyed() || progress == null) return;
    const poly = stableRoutes[0];
    if (!poly || poly.length < 2) return;
    const pos = along(poly, progress);

    // One persistent vehicle point, updated in place every tick.
    if (!vehicleRef.current) {
      vehicleCollRef.current = widget.scene.primitives.add(new PointPrimitiveCollection());
      vehicleRef.current = vehicleCollRef.current.add({
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
    widget.scene.requestRender();
  }, [ready, progress, heading, speedKmh, cameraMode, stableRoutes, color]);

  // Apply camera-mode changes from the cockpit.
  useEffect(() => {
    if (cameraMode) cameraRef.current?.setMode(cameraMode);
  }, [cameraMode]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={containerRef} aria-label={label ?? "3D map"} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 text-white/60 text-sm px-6 text-center">
          3D map unavailable — {error}
        </div>
      ) : loading ? (
        <MapLoading />
      ) : null}
    </div>
  );
}
