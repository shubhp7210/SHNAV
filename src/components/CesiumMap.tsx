import { useEffect, useMemo, useRef, useState } from "react";
import {
  CesiumWidget, Cartesian2, Cartesian3, Color, BoundingSphere, HeadingPitchRange,
  GroundPolylinePrimitive, GroundPolylineGeometry, GeometryInstance, Primitive,
  PolylineMaterialAppearance, PerInstanceColorAppearance, ColorGeometryInstanceAttribute,
  WallGeometry, Material, PointPrimitiveCollection, PointPrimitive, PolylineCollection,
  BillboardCollection, Billboard, LabelCollection, LabelStyle, VerticalOrigin,
  HorizontalOrigin, NearFarScalar, DistanceDisplayCondition, CameraEventType, Math as CMath,
} from "cesium";
import { createEngine, setTargetView, toCartesian, type EngineResult } from "@/lib/cesium/engine";
import { CameraController, type CameraMode } from "@/lib/cesium/cameraModes";
import { MANHATTAN_VIEW, regionFor, routesKey, type Pt, type TargetView } from "@/lib/geo/region";
import { BRAND_HEX, ROUTE_ALT_HEX, DEST_HEX } from "@/lib/theme";
import MapLoading from "@/components/MapLoading";

export interface FrameRequest {
  /** Change this number to trigger a camera move. 0 = no request. */
  key: number;
  /** Routes to fit (defaults to all routes on the map). */
  routes?: Pt[][];
  /** Fly to this view instead of fitting routes (e.g. "reset to Manhattan"). */
  view?: TargetView;
}

export interface CesiumMapProps {
  routes: Pt[][];       // routes[0] = active / selected flight
  progress?: number;    // 0..1 along routes[0] — enables the tracked vehicle
  heading?: number;     // vehicle heading (deg) from telemetry; omit if unknown
  speedKmh?: number;    // vehicle speed — feeds Forward-Flight look-ahead
  cameraMode?: CameraMode;
  /** Starting camera. Defaults to Manhattan — routes are NEVER auto-framed. */
  initialView?: TargetView;
  /** Draw routes[0] as a raised corridor at this display height (m). */
  corridorHeight?: number;
  /** Fly the camera to fit routes when `key` changes. */
  frame?: FrameRequest;
  /** Slow cinematic orbit around the starting view until the user interacts. */
  orbit?: boolean;
  /** Loop clearly-simulated aircraft along every route (ambient views only). */
  simulate?: boolean;
  /** Labels for routes[0] origin/destination. */
  endpointLabels?: [string, string];
  interactive?: boolean;
  /** false = mouse wheel scrolls the page instead of zooming (full-bleed heroes). */
  wheelZoom?: boolean;
  color?: string;
  label?: string;
  onReady?: (info: { geoDataLoaded: boolean; warnings: string[] }) => void;
}

const FIRST_FRAME_TIMEOUT_MS = 10_000;
const AMBIENT_FPS = 30;

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

/** Initial bearing a→b in degrees (0 = north). */
function bearing(a: Pt, b: Pt): number {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/** Top-down aircraft glyph (nose up) drawn to a canvas — avoids data: URI
 *  fetches, which the CSP's connect-src would block. Cached per color. */
const iconCache = new Map<string, HTMLCanvasElement>();
function aircraftIcon(color: string): HTMLCanvasElement {
  const hit = iconCache.get(color);
  if (hit) return hit;
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const g = c.getContext("2d");
  if (g) {
    g.translate(S / 2, S / 2);
    g.shadowColor = color; g.shadowBlur = 10;
    g.beginPath();
    // fuselage + wings + tail (stylised eVTOL/airframe silhouette)
    g.moveTo(0, -24);
    g.quadraticCurveTo(4, -20, 4, -10);
    g.lineTo(4, -4); g.lineTo(24, 4); g.lineTo(24, 9); g.lineTo(4, 5);
    g.lineTo(3, 15); g.lineTo(10, 20); g.lineTo(10, 24); g.lineTo(0, 21);
    g.lineTo(-10, 24); g.lineTo(-10, 20); g.lineTo(-3, 15);
    g.lineTo(-4, 5); g.lineTo(-24, 9); g.lineTo(-24, 4); g.lineTo(-4, -4);
    g.lineTo(-4, -10); g.quadraticCurveTo(-4, -20, 0, -24);
    g.closePath();
    g.fillStyle = color; g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 2.5; g.strokeStyle = "#ffffff"; g.stroke();
  }
  iconCache.set(color, c);
  return c;
}

/**
 * Cesium 3D map (CesiumWidget + primitives — no entity system / no eval).
 * WebGL-only: callers go through <MapView/>, which falls back to the canvas
 * renderer. Every map starts on Manhattan; route geometry is drawn exactly as
 * given — the ground track is clamped to terrain, and the optional corridor is
 * a labeled, illustrative altitude band.
 */
export default function CesiumMap({
  routes, progress, heading, speedKmh = 0, cameraMode, initialView = MANHATTAN_VIEW,
  corridorHeight, frame, orbit = false, simulate = false, endpointLabels,
  interactive = true, wheelZoom = true, color = BRAND_HEX, label, onReady,
}: CesiumMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EngineResult | null>(null);
  const vehicleRef = useRef<{ coll: BillboardCollection; bb: Billboard; ground: PointPrimitiveCollection; dot: PointPrimitive } | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const visibleRef = useRef(true);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Callers often pass a freshly built routes array every render; key effects
  // on the route *content* so geometry is only rebuilt when it actually changes.
  const key = routesKey(routes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRoutes = useMemo(() => routes, [key]);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const initialViewRef = useRef(initialView);
  const labelsKey = endpointLabels ? endpointLabels.join("|") : "";

  // ── Mount / unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let engine: EngineResult;
    try {
      engine = createEngine(el, initialViewRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "3D map failed to initialize.");
      return;
    }
    engineRef.current = engine;
    const { widget } = engine;
    widget.scene.screenSpaceCameraController.enableInputs = interactive;
    if (!wheelZoom) {
      widget.scene.screenSpaceCameraController.zoomEventTypes = [CameraEventType.RIGHT_DRAG, CameraEventType.PINCH];
    }
    // Dev-only handle for the headless map test harness.
    if (import.meta.env.DEV) (window as unknown as { __shnavMap?: CesiumWidget }).__shnavMap = widget;

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

    // Pause rendering entirely while the map is off-screen.
    const io = new IntersectionObserver(([entry]) => {
      if (widget.isDestroyed()) return;
      visibleRef.current = entry.isIntersecting;
      widget.useDefaultRenderLoop = entry.isIntersecting;
      if (entry.isIntersecting) widget.scene.requestRender();
    });
    io.observe(el);

    setReady(true);
    engine.layers.then((info) => {
      if (disposed) return;
      if (info.warnings.length) console.warn("[map]", info.warnings.join(" "));
      onReadyRef.current?.(info);
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
      vehicleRef.current = null;
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

  // ── Draw routes, corridor, beacons, labels (only when content changes) ────
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || engine.widget.isDestroyed()) return;
    const scene = engine.widget.scene;

    // Region = North America, widened if a route genuinely leaves it.
    engine.setBounds(regionFor(stableRoutes));

    const ground: GroundPolylinePrimitive[] = [];
    const prims: Primitive[] = [];
    const points = scene.primitives.add(new PointPrimitiveCollection()) as PointPrimitiveCollection;
    const lines = scene.primitives.add(new PolylineCollection()) as PolylineCollection;
    const labels = scene.primitives.add(new LabelCollection()) as LabelCollection;
    const brand = Color.fromCssColorString(color);
    const alt = Color.fromCssColorString(ROUTE_ALT_HEX);
    const dest = Color.fromCssColorString(DEST_HEX);

    // Draw alternates first and the active route last, so the active route's
    // pins/lines sit on top where endpoints are shared.
    const order = stableRoutes.map((poly, ri) => ({ poly, ri })).reverse();
    order.forEach(({ poly, ri }) => {
      if (poly.length < 2) return;
      const active = ri === 0;
      const positions = Cartesian3.fromDegreesArray(poly.flatMap((p) => [p.lng, p.lat]));

      // Ground track (clamped to terrain).
      const g = new GroundPolylinePrimitive({
        geometryInstances: new GeometryInstance({
          geometry: new GroundPolylineGeometry({ positions, width: active ? (corridorHeight ? 3 : 7) : 3 }),
        }),
        appearance: new PolylineMaterialAppearance({
          material: active
            ? (corridorHeight
              ? Material.fromType("Color", { color: brand.withAlpha(0.55) })
              : Material.fromType("PolylineGlow", { color: brand, glowPower: 0.25 }))
            : Material.fromType("PolylineDash", { color: alt.withAlpha(0.85), dashLength: 18 }),
        }),
      });
      scene.groundPrimitives.add(g);
      ground.push(g);

      // Endpoint pins.
      const pin = (p: Pt, c: Color, size: number) => points.add({
        position: toCartesian(p.lat, p.lng, 0), pixelSize: size, color: c,
        outlineColor: Color.WHITE, outlineWidth: 2.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, // always visible over terrain
      });
      const a = poly[0], b = poly[poly.length - 1];
      pin(a, active ? brand : alt, active ? 14 : 9);
      pin(b, active ? dest : alt, active ? 14 : 9);

      if (!active) return;

      // Raised corridor + translucent curtain down to the ground track.
      if (corridorHeight && corridorHeight > 0) {
        const raised = Cartesian3.fromDegreesArrayHeights(poly.flatMap((p) => [p.lng, p.lat, corridorHeight]));
        lines.add({
          positions: raised, width: 9,
          material: Material.fromType("PolylineGlow", { color: brand, glowPower: 0.22, taperPower: 1 }),
        });
        const wall = new Primitive({
          geometryInstances: new GeometryInstance({
            geometry: new WallGeometry({
              positions,
              maximumHeights: poly.map(() => corridorHeight),
              minimumHeights: poly.map(() => 0),
            }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(brand.withAlpha(0.13)) },
          }),
          appearance: new PerInstanceColorAppearance({ translucent: true, flat: true }),
          asynchronous: true,
        });
        scene.primitives.add(wall);
        prims.push(wall);
      }

      // Vertical beacons at origin/destination.
      const beaconTop = Math.max(corridorHeight ?? 0, 180);
      for (const [p, c] of [[a, brand], [b, dest]] as [Pt, Color][]) {
        lines.add({
          positions: [toCartesian(p.lat, p.lng, 0), toCartesian(p.lat, p.lng, beaconTop)],
          width: 3, material: Material.fromType("Color", { color: c.withAlpha(0.9) }),
        });
      }

      if (endpointLabels) {
        endpointLabels.forEach((text, i) => {
          if (!text) return;
          const p = i === 0 ? a : b;
          labels.add({
            position: toCartesian(p.lat, p.lng, beaconTop + 40),
            text: text.length > 28 ? text.slice(0, 27) + "…" : text,
            font: "600 13px 'Plus Jakarta Sans', system-ui, sans-serif",
            fillColor: Color.WHITE, outlineColor: Color.fromCssColorString("#05070b"), outlineWidth: 4,
            style: LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER,
            pixelOffset: new Cartesian2(0, -4),
            scaleByDistance: new NearFarScalar(1500, 1, 60_000, 0.7),
            distanceDisplayCondition: new DistanceDisplayCondition(0, 400_000),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          });
        });
      }
    });

    cameraRef.current?.setRoute(stableRoutes[0] ?? []);
    scene.requestRender();

    return () => {
      if (engine.widget.isDestroyed()) return;
      ground.forEach((p) => scene.groundPrimitives.remove(p));
      prims.forEach((p) => scene.primitives.remove(p));
      scene.primitives.remove(points);
      scene.primitives.remove(lines);
      scene.primitives.remove(labels);
      scene.requestRender();
    };
    // labelsKey stands in for endpointLabels (array identity changes each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stableRoutes, color, corridorHeight, labelsKey]);

  // ── Frame on request (never automatic) ────────────────────────────────────
  useEffect(() => {
    const widget = engineRef.current?.widget;
    if (!ready || !widget || widget.isDestroyed() || !frame || frame.key === 0) return;
    if (cameraRef.current) return; // tracking camera owns the view
    if (frame.view) {
      const v = frame.view;
      widget.camera.flyToBoundingSphere(new BoundingSphere(toCartesian(v.lat, v.lng, 0), 0), {
        duration: 1.6,
        offset: new HeadingPitchRange(CMath.toRadians(v.heading), CMath.toRadians(v.pitch), v.range),
      });
      return;
    }
    const target = (frame.routes ?? stableRoutes).flat();
    if (target.length === 0) return;
    const sphere = BoundingSphere.fromPoints(target.map((p) => toCartesian(p.lat, p.lng, corridorHeight ?? 0)));
    widget.camera.flyToBoundingSphere(sphere, {
      duration: 1.6,
      offset: new HeadingPitchRange(CMath.toRadians(29), CMath.toRadians(-36), Math.max(1800, sphere.radius * 3)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, frame?.key]);

  // ── Ambient: cinematic orbit + clearly-simulated traffic (home page) ──────
  useEffect(() => {
    const widget = engineRef.current?.widget;
    if (!ready || !widget || widget.isDestroyed() || (!orbit && !simulate)) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const scene = widget.scene;
    const v = initialViewRef.current;
    let hdg = v.heading;
    let orbiting = orbit && !reduced;
    const stopOrbit = () => { orbiting = false; };
    const canvas = widget.canvas;
    canvas.addEventListener("pointerdown", stopOrbit);
    canvas.addEventListener("wheel", stopOrbit, { passive: true });
    canvas.addEventListener("touchstart", stopOrbit, { passive: true });

    const sims: { bb: Billboard; poly: Pt[]; offset: number; height: number }[] = [];
    const coll = simulate ? (scene.primitives.add(new BillboardCollection()) as BillboardCollection) : null;
    if (coll) {
      stableRoutes.forEach((poly, i) => {
        if (poly.length < 2) return;
        const h = 140 + (i % 3) * 90;
        const bb = coll.add({
          image: aircraftIcon(i === 0 ? color : ROUTE_ALT_HEX), scale: 0.5,
          position: toCartesian(poly[0].lat, poly[0].lng, h),
          alignedAxis: Cartesian3.UNIT_Z,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        sims.push({ bb, poly, offset: i * 0.27, height: h });
      });
    }

    let raf = 0, last = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visibleRef.current || now - last < 1000 / AMBIENT_FPS) return;
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      if (orbiting) {
        hdg = (hdg + dt * 2.2) % 360; // ~2.2°/s
        setTargetView(widget, { ...v, heading: hdg });
      }
      for (const s of sims) {
        const t = (((now - t0) / 26_000) + s.offset) % 1;
        const p = along(s.poly, t);
        const n = along(s.poly, Math.min(1, t + 0.01));
        s.bb.position = toCartesian(p.lat, p.lng, s.height);
        s.bb.rotation = -CMath.toRadians(bearing(p, n));
      }
      if (orbiting || sims.length) scene.requestRender();
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", stopOrbit);
      canvas.removeEventListener("wheel", stopOrbit);
      canvas.removeEventListener("touchstart", stopOrbit);
      if (coll && !widget.isDestroyed()) scene.primitives.remove(coll);
    };
  }, [ready, orbit, simulate, stableRoutes, color]);

  // ── Tracked vehicle + tracking camera (driven by progress/heading) ────────
  useEffect(() => {
    const widget = engineRef.current?.widget;
    if (!ready || !widget || widget.isDestroyed() || progress == null) return;
    const poly = stableRoutes[0];
    if (!poly || poly.length < 2) return;
    const pos = along(poly, progress);
    const next = along(poly, Math.min(1, progress + 0.02));
    const hdg = heading ?? bearing(pos, next);
    const h = corridorHeight ?? 0;

    if (!vehicleRef.current) {
      const coll = widget.scene.primitives.add(new BillboardCollection()) as BillboardCollection;
      const bb = coll.add({
        image: aircraftIcon(color), scale: 0.62,
        position: toCartesian(pos.lat, pos.lng, h),
        alignedAxis: Cartesian3.UNIT_Z,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      const groundColl = widget.scene.primitives.add(new PointPrimitiveCollection()) as PointPrimitiveCollection;
      const dot = groundColl.add({
        position: toCartesian(pos.lat, pos.lng, 0), pixelSize: 7,
        color: Color.fromCssColorString(color).withAlpha(0.6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      vehicleRef.current = { coll, bb, ground: groundColl, dot };
    }
    const v = vehicleRef.current;
    v.bb.position = toCartesian(pos.lat, pos.lng, h);
    v.bb.rotation = -CMath.toRadians(hdg);
    v.dot.position = toCartesian(pos.lat, pos.lng, 0);

    if (!cameraRef.current) {
      cameraRef.current = new CameraController(widget, initialViewRef.current);
      cameraRef.current.setRoute(poly);
      cameraRef.current.setMode(cameraMode ?? "follow");
    }
    cameraRef.current.setVehicle({ lat: pos.lat, lng: pos.lng, alt: h, heading: hdg, speedKmh, ts: performance.now() });
    widget.scene.requestRender();
  }, [ready, progress, heading, speedKmh, cameraMode, stableRoutes, color, corridorHeight]);

  useEffect(() => {
    if (cameraMode) cameraRef.current?.setMode(cameraMode);
  }, [cameraMode]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={containerRef} aria-label={label ?? "3D map"} role="img" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground text-sm px-6 text-center">
          3D map unavailable — {error}
        </div>
      ) : loading ? (
        <MapLoading />
      ) : null}
    </div>
  );
}
