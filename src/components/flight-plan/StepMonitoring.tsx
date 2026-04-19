import { useState, useEffect, useRef } from "react";
import { CheckCircle, AlertTriangle, Radio, Lock, Unlock, Volume2, VolumeX, Navigation, Zap, Activity } from "lucide-react";
import type { FlightPlanData } from "@/pages/FlightPlan";
import type { TrajectoryPredictorResult, FutureConflict } from "@/lib/atmTypes";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { FlightAudio, haptic } from "@/lib/flightAudio";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
}

// ── Location lookup ───────────────────────────────────────────────────────────
// Quick fallback table for common cities — Nominatim geocoding is the primary source.
const LOCATION_COORDS: Record<string, [number, number]> = {
  "new york": [-73.985, 40.748], "nyc": [-73.985, 40.748],
  "manhattan": [-73.97, 40.776], "brooklyn": [-73.944, 40.678],
  "jfk": [-73.779, 40.641],     "laguardia": [-73.872, 40.776],
  "newark": [-74.175, 40.69],   "hoboken": [-74.031, 40.744],
  "jersey city": [-74.047, 40.718],
  "los angeles": [-118.243, 34.052], "lax": [-118.408, 33.942],
  "chicago": [-87.623, 41.883], "miami": [-80.191, 25.761],
  "houston": [-95.369, 29.76],  "phoenix": [-112.074, 33.448],
  "seattle": [-122.332, 47.606], "boston": [-71.057, 42.361],
  "dallas": [-96.797, 32.776],  "atlanta": [-84.388, 33.749],
  "denver": [-104.990, 39.739], "san francisco": [-122.419, 37.774],
  "sfo": [-122.375, 37.619],    "london": [-0.118, 51.509],
  "paris": [2.349, 48.864],     "tokyo": [139.692, 35.69],
};

function getCoords(loc: string, fb: [number, number]): [number, number] {
  if (!loc) return fb;
  // Pattern: "<name> @ lat,lon" — appended by LocationInput when a real address is picked
  const tagged = loc.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (tagged) {
    const lat = parseFloat(tagged[1]);
    const lon = parseFloat(tagged[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lon, lat];
  }
  // Pattern: bare "lat,lon"
  const bare = loc.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lon = parseFloat(bare[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lon, lat];
  }
  const k = loc.toLowerCase().trim();
  for (const [key, val] of Object.entries(LOCATION_COORDS)) {
    if (k.includes(key)) return val;
  }
  return fb;
}

// Async geocoder — uses Nominatim for any unknown address.
async function geocode(loc: string, fb: [number, number]): Promise<[number, number]> {
  const synchronous = getCoords(loc, fb);
  // If sync resolved to something other than fallback, use it
  if (synchronous[0] !== fb[0] || synchronous[1] !== fb[1]) return synchronous;
  if (!loc.trim()) return fb;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(loc)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    const arr = await res.json();
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
      return [parseFloat(arr[0].lon), parseFloat(arr[0].lat)];
    }
  } catch { /* network errors fall back */ }
  return fb;
}

function buildRoute(a: [number, number], b: [number, number], n = 160): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const curve = Math.sin(t * Math.PI) * 0.014;
    pts.push([a[0] + (b[0] - a[0]) * t + curve * 0.3, a[1] + (b[1] - a[1]) * t + curve]);
  }
  return pts;
}

function calcBearing(a: [number, number], b: [number, number]): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const d = (v: number) => (v * 180) / Math.PI;
  const dl = r(b[0] - a[0]);
  const y = Math.sin(dl) * Math.cos(r(b[1]));
  const x = Math.cos(r(a[1])) * Math.sin(r(b[1])) - Math.sin(r(a[1])) * Math.cos(r(b[1])) * Math.cos(dl);
  return (d(Math.atan2(y, x)) + 360) % 360;
}

// ── CSS injection (once) ──────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById("altos-map-css")) return;
  const s = document.createElement("style");
  s.id = "altos-map-css";
  s.textContent = `
    @keyframes altos-pulse {
      0%   { transform: scale(1);   opacity: 0.85; }
      70%  { transform: scale(2.8); opacity: 0; }
      100% { transform: scale(2.8); opacity: 0; }
    }
    .altos-ring { animation: altos-pulse 2.2s ease-out infinite; }

    /* Navigation control dark theme */
    .maplibregl-ctrl-group {
      background: rgba(5,10,22,0.88) !important;
      border: 1px solid rgba(45,212,191,0.22) !important;
      border-radius: 10px !important;
      box-shadow: 0 0 20px rgba(45,212,191,0.08) !important;
    }
    .maplibregl-ctrl button {
      background-color: transparent !important;
      border-bottom-color: rgba(45,212,191,0.15) !important;
    }
    .maplibregl-ctrl button:hover { background-color: rgba(45,212,191,0.08) !important; }
    .maplibregl-ctrl button .maplibregl-ctrl-icon { filter: invert(1) brightness(0.7) !important; }
    .maplibregl-ctrl-compass .maplibregl-ctrl-icon { filter: none !important; }
    .maplibregl-popup-content {
      background: rgba(5,10,22,0.92) !important;
      border: 1px solid rgba(45,212,191,0.25) !important;
      border-radius: 8px !important;
      color: #e2e8f0 !important;
      font-family: 'JetBrains Mono', monospace !important;
      font-size: 12px !important;
      padding: 10px 14px !important;
    }
    .maplibregl-popup-tip { display: none !important; }
  `;
  document.head.appendChild(s);
}

// ── Marker helpers ────────────────────────────────────────────────────────────
function createAircraftEl(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:44px;height:44px;position:relative;cursor:default;";
  wrap.innerHTML = `
    <div class="altos-ring" style="
      position:absolute;inset:10px;border-radius:50%;
      background:rgba(45,212,191,0.4);
    "></div>
    <div style="
      position:absolute;inset:7px;border-radius:50%;
      background:radial-gradient(circle at 40% 35%, #0d2a3a, #050a14);
      border:2px solid #2dd4bf;
      box-shadow:0 0 20px rgba(45,212,191,0.9),inset 0 0 10px rgba(45,212,191,0.15);
      display:flex;align-items:center;justify-content:center;
    ">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="#2dd4bf"
           style="filter:drop-shadow(0 0 6px #2dd4bf);margin-top:-1px">
        <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8
                 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1
                 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
      </svg>
    </div>
  `;
  return wrap;
}

function createDotMarker(color: string, glow: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = `<div style="
    width:16px;height:16px;border-radius:50%;
    background:${color};
    border:2.5px solid rgba(255,255,255,0.9);
    box-shadow:0 0 18px ${glow}, 0 0 6px ${glow};
  "></div>`;
  return el;
}

// ── Dark-theme overrides applied post-load ────────────────────────────────────
function applyDarkTheme(map: maplibregl.Map) {
  const layers = map.getStyle()?.layers ?? [];
  layers.forEach((layer) => {
    const id = layer.id;
    const lo = id.toLowerCase();
    try {
      if (layer.type === "background") {
        map.setPaintProperty(id, "background-color", "#050a14");
      } else if (layer.type === "fill") {
        if (lo.includes("water")) {
          map.setPaintProperty(id, "fill-color", "#060e1e");
          map.setPaintProperty(id, "fill-opacity", 1);
        } else if (lo.includes("building")) {
          map.setPaintProperty(id, "fill-opacity", 0); // hide flat buildings
        } else if (lo.includes("park") || lo.includes("green") || lo.includes("grass") || lo.includes("wood")) {
          map.setPaintProperty(id, "fill-color", "#060f18");
          map.setPaintProperty(id, "fill-opacity", 0.9);
        } else {
          map.setPaintProperty(id, "fill-color", "#07101e");
          map.setPaintProperty(id, "fill-opacity", 0.95);
        }
      } else if (layer.type === "line") {
        if (lo.includes("water") || lo.includes("river") || lo.includes("stream")) {
          map.setPaintProperty(id, "line-color", "#07111e");
        } else if (lo.includes("motorway") || lo.includes("trunk")) {
          map.setPaintProperty(id, "line-color", "#0f2a50");
        } else if (lo.includes("primary") || lo.includes("secondary")) {
          map.setPaintProperty(id, "line-color", "#0a1f3a");
        } else if (lo.includes("road") || lo.includes("street") || lo.includes("transport")) {
          map.setPaintProperty(id, "line-color", "#07131f");
        } else {
          map.setPaintProperty(id, "line-color", "#060d1a");
        }
      } else if (layer.type === "symbol") {
        try { map.setPaintProperty(id, "text-color", "#1a4565"); } catch {}
        try { map.setPaintProperty(id, "text-halo-color", "#030710"); } catch {}
        try { map.setPaintProperty(id, "text-opacity", 0.55); } catch {}
        try { map.setPaintProperty(id, "icon-opacity", 0.3); } catch {}
      } else if (layer.type === "fill-extrusion") {
        map.setPaintProperty(id, "fill-extrusion-opacity", 0); // remove existing 3D
      }
    } catch { /* per-layer errors are non-fatal */ }
  });
}

// ── Building color expression (dark navy → bright cyan by height) ─────────────
const BUILDING_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"],
  ["coalesce", ["get", "render_height"], ["get", "height"], 5],
  0,   "#060e1e",
  8,   "#081828",
  18,  "#0a2840",
  35,  "#0b3d65",
  60,  "#0b5285",
  90,  "#0a72a8",
  130, "#0891b2",
  180, "#06b6d4",
  260, "#22d3ee",
];

const ROOF_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"],
  ["coalesce", ["get", "render_height"], ["get", "height"], 5],
  0,   "#0d1e32",
  25,  "#163d60",
  60,  "#1670a0",
  120, "#1a98c8",
  200, "#38bdf8",
  300, "#7dd3fc",
];

// ─────────────────────────────────────────────────────────────────────────────
const StepMonitoring = ({ data, updateData }: Props) => {
  const mapContainer  = useRef<HTMLDivElement>(null);
  const mapRef        = useRef<maplibregl.Map | null>(null);
  const markerRef     = useRef<maplibregl.Marker | null>(null);
  const animRef       = useRef<number | null>(null);
  const startTsRef    = useRef<number | null>(null);
  const lastCamTs     = useRef<number>(0);
  const routePts      = useRef<[number, number][]>([]);
  const followRef     = useRef(true);
  const audioRef      = useRef<FlightAudio | null>(null);
  const lastStatusRef = useRef<"nominal" | "alert">("nominal");
  const waypointsHit  = useRef(new Set<number>());  // 25 / 50 / 75 / 100

  const [progress,   setProgress]   = useState(0);
  const [status,     setStatus]     = useState<"nominal" | "alert">("nominal");
  const [mapReady,   setMapReady]   = useState(false);
  const [followMode, setFollowMode] = useState(true);
  const [muted,      setMuted]      = useState(false);
  const [liveConflicts, setLiveConflicts] = useState<FutureConflict[]>([]);
  const [flowEfficiency, setFlowEfficiency] = useState(100);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [origin, setOrigin]           = useState<[number, number]>([-73.985, 40.748]);
  const [destination, setDestination] = useState<[number, number]>([-73.94, 40.795]);
  const [coordsResolved, setCoordsResolved] = useState(false);

  // Resolve real lat/lon for both endpoints (Nominatim async fallback)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [o, d] = await Promise.all([
        geocode(data.origin, [-73.985, 40.748]),
        geocode(data.destination, [-73.94, 40.795]),
      ]);
      if (cancelled) return;
      setOrigin(o);
      setDestination(d);
      setCoordsResolved(true);
    })();
    return () => { cancelled = true; };
  }, [data.origin, data.destination]);

  // ── Map init ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || !data.monitoringActive || !coordsResolved) return;
    if (mapRef.current) return;

    injectStyles();
    routePts.current = buildRoute(origin, destination);
    const pts = routePts.current;
    const center: [number, number] = [
      (origin[0] + destination[0]) / 2,
      (origin[1] + destination[1]) / 2,
    ];
    const initBearing = calcBearing(origin, destination);

    const map = new maplibregl.Map({
      container: mapContainer.current,
      // OpenFreeMap — free vector tiles with building heights, no API key needed
      style: "https://tiles.openfreemap.org/styles/liberty",
      center,
      zoom: 14.5,
      pitch: 58,
      bearing: initBearing,
      maxPitch: 85,
      antialias: true,
    });

    // ── Controls ──────────────────────────────────────────────────────────
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
      "top-right"
    );

    // ── User interaction → disable follow ─────────────────────────────────
    const disableFollow = () => {
      followRef.current = false;
      setFollowMode(false);
    };
    map.on("dragstart", disableFollow);
    map.on("wheel",     disableFollow);
    map.on("touchstart", disableFollow);

    // ── After tiles load ──────────────────────────────────────────────────
    map.on("load", () => {
      // Dark cyberpunk theme
      applyDarkTheme(map);

      // Atmospheric fog
      try {
        (map as any).setFog({
          color:           "rgba(3, 8, 20, 0.92)",
          "high-color":    "rgba(5, 18, 50, 0.65)",
          "horizon-blend": 0.05,
          "space-color":   "#00030e",
          "star-intensity": 0.35,
        });
      } catch { /* older MapLibre versions may not support setFog */ }

      // Find the vector source that OpenFreeMap loaded
      const vectorSourceId = Object.entries(map.getStyle().sources ?? {})
        .find(([, src]) => (src as any).type === "vector")?.[0];

      if (vectorSourceId) {
        // ── 3D building walls ────────────────────────────────────────────
        map.addLayer({
          id: "altos-buildings-walls",
          type: "fill-extrusion",
          source: vectorSourceId,
          "source-layer": "building",
          minzoom: 11,
          paint: {
            "fill-extrusion-color": BUILDING_COLOR_EXPR,
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 5],
            "fill-extrusion-base":   ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
            "fill-extrusion-opacity": [
              "interpolate", ["linear"], ["zoom"],
              11, 0,
              13, 0.88,
            ],
          },
        });

        // ── 3D building rooftops (brighter highlight layer) ───────────────
        map.addLayer({
          id: "altos-buildings-roofs",
          type: "fill-extrusion",
          source: vectorSourceId,
          "source-layer": "building",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": ROOF_COLOR_EXPR,
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 5],
            "fill-extrusion-base": [
              "*",
              ["coalesce", ["get", "render_height"], ["get", "height"], 5],
              0.975,
            ],
            "fill-extrusion-opacity": [
              "interpolate", ["linear"], ["zoom"],
              14, 0,
              15.5, 0.95,
            ],
          },
        });
      }

      // ── Route sources ─────────────────────────────────────────────────
      map.addSource("route-full", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } },
      });
      map.addSource("route-traveled", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [pts[0], pts[0]] } },
      });

      // Full route — outer atmospheric glow
      map.addLayer({
        id: "route-full-glow2",
        type: "line", source: "route-full",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2dd4bf", "line-width": 20, "line-opacity": 0.05 },
      });
      // Full route — dashed ghost
      map.addLayer({
        id: "route-full-dash",
        type: "line", source: "route-full",
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": "#2dd4bf", "line-width": 1.5, "line-opacity": 0.28, "line-dasharray": [6, 9] },
      });

      // Traveled trail — wide glow
      map.addLayer({
        id: "route-trav-glow",
        type: "line", source: "route-traveled",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2dd4bf", "line-width": 20, "line-opacity": 0.18 },
      });
      // Traveled trail — medium glow
      map.addLayer({
        id: "route-trav-mid",
        type: "line", source: "route-traveled",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#5eead4", "line-width": 7, "line-opacity": 0.4 },
      });
      // Traveled trail — bright core
      map.addLayer({
        id: "route-trav-core",
        type: "line", source: "route-traveled",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ccfbf1", "line-width": 2.5, "line-opacity": 0.95 },
      });

      // ── Origin marker ─────────────────────────────────────────────────
      new maplibregl.Marker({ element: createDotMarker("#2dd4bf", "rgba(45,212,191,0.8)") })
        .setLngLat(origin)
        .setPopup(
          new maplibregl.Popup({ offset: 18 }).setHTML(
            `<span style="color:#2dd4bf;font-weight:600">▲ ORIGIN</span><br>${data.origin || "Start"}`
          )
        )
        .addTo(map);

      // ── Destination marker ────────────────────────────────────────────
      new maplibregl.Marker({ element: createDotMarker("#f59e0b", "rgba(245,158,11,0.8)") })
        .setLngLat(destination)
        .setPopup(
          new maplibregl.Popup({ offset: 18 }).setHTML(
            `<span style="color:#f59e0b;font-weight:600">◆ DESTINATION</span><br>${data.destination || "End"}`
          )
        )
        .addTo(map);

      // ── Aircraft marker ───────────────────────────────────────────────
      const aircraftEl = createAircraftEl();
      const marker = new maplibregl.Marker({
        element: aircraftEl,
        rotationAlignment: "map",
        rotation: initBearing,
      })
        .setLngLat(pts[0])
        .addTo(map);
      markerRef.current = marker;

      setMapReady(true);
    });

    mapRef.current = map;

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      map.remove();
      audioRef.current?.destroy();
      audioRef.current    = null;
      mapRef.current      = null;
      markerRef.current   = null;
      startTsRef.current  = null;
      followRef.current   = true;
      lastStatusRef.current = "nominal";
      waypointsHit.current.clear();
      setMapReady(false);
      setProgress(0);
      setStatus("nominal");
      setFollowMode(true);
      setMuted(false);
    };
  }, [data.monitoringActive, coordsResolved, origin, destination]);

  // ── Trajectory polling every 5 seconds ───────────────────────────────────
  useEffect(() => {
    if (!data.monitoringActive) return;
    const poll = async () => {
      try {
        const { data: res } = await supabase.functions.invoke("trajectory-predictor", {
          body: { flight_intent_id: data.flightIntentId },
        });
        if (res) {
          const r = res as TrajectoryPredictorResult;
          setLiveConflicts(r.future_conflicts ?? []);
          setFlowEfficiency(r.system_flow_efficiency ?? 100);
        }
      } catch { /* silent */ }
    };
    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [data.monitoringActive, data.flightIntentId]);

  // ── Animation (starts only once mapReady is true) ─────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    const map    = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;

    const pts      = routePts.current;
    const DURATION = 48_000; // 48 s full flight
    startTsRef.current = null;

    // Start ambient audio + haptic pulse on launch
    audioRef.current?.startAmbient();
    haptic([40, 20, 80, 20, 120]);

    const animate = (ts: number) => {
      if (!startTsRef.current) startTsRef.current = ts;
      const t   = Math.min((ts - startTsRef.current) / DURATION, 1);
      const idx = Math.min(Math.floor(t * (pts.length - 1)), pts.length - 2);
      const pos = pts[idx];
      const pct = Math.round(t * 100);

      setProgress(t);
      const newStatus: "nominal" | "alert" = t >= 0.28 && t < 0.42 ? "alert" : "nominal";
      setStatus(newStatus);

      // ── Status change events ─────────────────────────────────────────
      if (newStatus !== lastStatusRef.current) {
        lastStatusRef.current = newStatus;
        if (newStatus === "alert") {
          audioRef.current?.playAlert();
          haptic([150, 80, 150, 80, 200]); // warning pattern
        } else {
          audioRef.current?.playAlertClear();
          haptic([60]);
        }
      }

      // ── Waypoint pings at 25 / 50 / 75 / 100 % ──────────────────────
      for (const mark of [25, 50, 75]) {
        if (pct >= mark && !waypointsHit.current.has(mark)) {
          waypointsHit.current.add(mark);
          audioRef.current?.playWaypoint();
          haptic([30]);
        }
      }

      // ── Arrival ──────────────────────────────────────────────────────
      if (t >= 1 && !waypointsHit.current.has(100)) {
        waypointsHit.current.add(100);
        audioRef.current?.playArrival();
        audioRef.current?.stopAmbient(3);
        haptic([80, 40, 80, 40, 300]); // celebration
      }

      // Move + rotate aircraft
      marker.setLngLat(pos);
      const nextIdx = Math.min(idx + 6, pts.length - 1);
      const head    = calcBearing(pos, pts[nextIdx]);
      marker.setRotation(head);

      // Grow traveled trail
      const src = map.getSource("route-traveled") as maplibregl.GeoJSONSource | undefined;
      src?.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: pts.slice(0, idx + 1) },
      });

      // Smooth camera follow — throttled to every 600 ms to avoid fighting the user
      if (followRef.current && ts - lastCamTs.current > 600) {
        lastCamTs.current = ts;
        map.easeTo({
          center:   pos,
          bearing:  head,
          pitch:    60,
          zoom:     15,
          duration: 900,
          easing:   (x) => 1 - Math.pow(1 - x, 3), // ease-out cubic
        });
      }

      if (t < 1) animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [mapReady]);

  // ── Idle screen ───────────────────────────────────────────────────────────
  if (!data.monitoringActive) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground text-sm">
          Real-time 3D flight monitoring with immersive city visualization.
        </p>
        <div className="py-14 text-center space-y-5">
          <div className="relative inline-flex items-center justify-center w-16 h-16 mx-auto">
            <div className="absolute inset-0 rounded-full bg-primary/10 animate-ping" />
            <div className="absolute inset-2 rounded-full bg-primary/5 animate-pulse" />
            <Radio className="relative w-8 h-8 text-primary opacity-70" />
          </div>
          <div>
            <p className="text-foreground font-medium">3D City Map — Ready</p>
            <p className="text-muted-foreground text-sm mt-1">
              Monitoring activates once the simulation begins.
            </p>
          </div>
          <button
            onClick={() => {
              // Init audio on user gesture (browser autoplay policy)
              const audio = new FlightAudio();
              audio.init();
              audio.playTakeoff();
              audioRef.current = audio;
              haptic([60, 30, 120]);
              updateData({ monitoringActive: true });
            }}
            className="px-7 py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-sm
                       hover:opacity-90 active:scale-95 transition-all duration-150
                       shadow-[0_0_30px_-4px_hsl(175,70%,45%,0.6)]"
          >
            Launch 3D Simulation
          </button>
        </div>
      </div>
    );
  }

  const pct = Math.round(progress * 100);
  const eta = Math.max(0, Math.round((1 - progress) * 48));

  return (
    <div className="space-y-4">
      {/* ── Status bar ────────────────────────────────────────────────── */}
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border transition-colors duration-500 ${
          status === "nominal"
            ? "border-primary/30 bg-primary/5"
            : "border-accent/50 bg-accent/10"
        }`}
      >
        {status === "nominal" ? (
          <CheckCircle className="w-5 h-5 text-primary flex-shrink-0" />
        ) : (
          <AlertTriangle className="w-5 h-5 text-accent flex-shrink-0 animate-pulse" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">
            {status === "nominal" ? "On Track — Nominal" : "Deviation Detected"}
          </p>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {status === "nominal"
              ? "All trajectory constraints within tolerance"
              : "Minor lateral deviation — evaluating corridor"}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">ETA</p>
          <p className="text-sm font-mono font-bold text-primary">{eta}s</p>
        </div>
      </div>

      {/* ── Progress bar ──────────────────────────────────────────────── */}
      <div className="h-[3px] rounded-full bg-secondary overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-cyan-300 transition-all duration-300"
          style={{ width: `${pct}%`, boxShadow: "0 0 10px hsl(175 70% 45% / 0.8)" }}
        />
      </div>

      {/* ── 3D Map ────────────────────────────────────────────────────── */}
      <div
        className="relative w-full rounded-xl overflow-hidden border border-primary/20"
        style={{ height: "460px", boxShadow: "0 0 40px -8px rgba(45,212,191,0.2)" }}
      >
        <div ref={mapContainer} className="absolute inset-0" />

        {/* Vignette overlay for immersive look */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 55%, rgba(5,10,20,0.55) 100%)",
          }}
        />

        {/* Bottom-left controls */}
        <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2">
          {/* Follow / Explore toggle */}
          <button
            onClick={() => {
              const next = !followRef.current;
              followRef.current = next;
              setFollowMode(next);
              haptic([20]);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full
              text-[11px] font-mono font-semibold border backdrop-blur-md transition-all duration-200
              ${followMode
                ? "bg-primary/20 border-primary/50 text-primary shadow-[0_0_14px_-2px_rgba(45,212,191,0.45)]"
                : "bg-black/50 border-white/10 text-white/50 hover:border-white/25"
              }`}
          >
            {followMode
              ? <><Lock className="w-3 h-3" />Following</>
              : <><Unlock className="w-3 h-3" />Explore</>
            }
          </button>

          {/* Mute / Unmute */}
          <button
            onClick={() => {
              const next = !muted;
              setMuted(next);
              audioRef.current?.setMuted(next);
              haptic([15]);
            }}
            className="flex items-center justify-center w-7 h-7 rounded-full
              bg-black/50 border border-white/10 text-white/50
              hover:border-white/25 hover:text-white/80 backdrop-blur-md
              transition-all duration-200"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted
              ? <VolumeX className="w-3 h-3" />
              : <Volume2 className="w-3 h-3" />
            }
          </button>
        </div>

        {/* Hint text */}
        <div className="absolute top-3 left-3 z-10 pointer-events-none">
          <p className="text-[10px] font-mono text-white/30 leading-4">
            Scroll · Drag · Pinch to explore
          </p>
        </div>
      </div>

      {/* ── Info strip ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: "FROM",     value: data.origin      || "—", color: "text-primary" },
          { label: "ALT BAND", value: data.altitudeBand.toUpperCase() },
          { label: "PROGRESS", value: `${pct}%` },
          { label: "TO",       value: data.destination || "—" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-secondary/50 rounded-lg p-3 text-center border border-border/30">
            <p className={`text-xs font-mono font-bold truncate ${color ?? "text-foreground"}`}>{value}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5 tracking-wider">{label}</p>
          </div>
        ))}
      </div>

      {/* ── Live Trajectory Intelligence ──────────────────────────────── */}
      <div className="rounded-xl border border-white/10 bg-black/20 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">Live Trajectory</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Zap className="w-3 h-3 text-cyan-400" />
              <span className="text-[10px] text-white/40">Flow</span>
              <span className={`text-[10px] font-bold ${flowEfficiency >= 80 ? "text-emerald-400" : flowEfficiency >= 60 ? "text-amber-400" : "text-red-400"}`}>
                {flowEfficiency}%
              </span>
            </div>
            <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${liveConflicts.length > 0 ? "bg-red-400" : "bg-emerald-400"}`} />
            <span className="text-[10px] text-white/30">5s poll</span>
          </div>
        </div>
        <div className="p-3">
          {liveConflicts.length === 0 ? (
            <div className="flex items-center gap-2 text-emerald-400 text-xs">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
              No future conflicts in 5-minute horizon
            </div>
          ) : (
            <div className="space-y-2">
              {liveConflicts.slice(0, 3).map((c, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between p-2 rounded-lg text-xs border ${
                    c.severity === "high" ? "border-red-500/30 bg-red-500/5 text-red-300" :
                    c.severity === "moderate" ? "border-amber-500/30 bg-amber-500/5 text-amber-300" :
                    "border-yellow-500/20 bg-yellow-500/5 text-yellow-300"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    <span>{c.aircraft_a} ↔ {c.aircraft_b}</span>
                    <span className="text-white/30">T+{c.t_plus_min}m</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-white/40">
                    <Navigation className="w-3 h-3" />
                    <span className="text-[10px] truncate max-w-[120px]">{c.resolution.action}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StepMonitoring;
