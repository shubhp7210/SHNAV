import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Zap, Navigation, Activity, Clock, Wind, Plane } from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildRoute(a: [number, number], b: [number, number], n = 240, arcFactor = 0.014): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const arc = Math.sin(t * Math.PI) * arcFactor;
    pts.push([a[0] + (b[0] - a[0]) * t + arc * 0.5, a[1] + (b[1] - a[1]) * t + arc]);
  }
  return pts;
}

function calcBearing(a: [number, number], b: [number, number]): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dl = r(b[0] - a[0]);
  const y = Math.sin(dl) * Math.cos(r(b[1]));
  const x = Math.cos(r(a[1])) * Math.sin(r(b[1])) - Math.sin(r(a[1])) * Math.cos(r(b[1])) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ── Aircraft marker ───────────────────────────────────────────────────────────
function createAircraftEl(color: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:38px;height:38px;position:relative;pointer-events:none;";
  wrap.innerHTML = `
    <div style="position:absolute;inset:9px;border-radius:50%;background:${color}44;
      animation:altos-hero-pulse 2.4s ease-out infinite;"></div>
    <div style="position:absolute;inset:6px;border-radius:50%;
      background:radial-gradient(circle at 38% 32%,#0d2a3a,#050a14);
      border:1.5px solid ${color};
      box-shadow:0 0 18px ${color}cc,inset 0 0 8px ${color}22;
      display:flex;align-items:center;justify-content:center;">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="${color}"
           style="filter:drop-shadow(0 0 5px ${color});margin-top:-1px">
        <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8
                 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1
                 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
      </svg>
    </div>`;
  return wrap;
}

// ── Dark theme with VISIBLE city labels ───────────────────────────────────────
function applyDarkTheme(map: maplibregl.Map) {
  const layers = map.getStyle()?.layers ?? [];
  layers.forEach((layer) => {
    const id = layer.id;
    const lo = id.toLowerCase();
    try {
      if (layer.type === "background") {
        map.setPaintProperty(id, "background-color", "#040912");
      } else if (layer.type === "fill") {
        if (lo.includes("water")) {
          map.setPaintProperty(id, "fill-color", "#050c1a");
          map.setPaintProperty(id, "fill-opacity", 1);
        } else if (lo.includes("building")) {
          map.setPaintProperty(id, "fill-opacity", 0);
        } else if (lo.includes("park") || lo.includes("green") || lo.includes("grass") || lo.includes("wood")) {
          map.setPaintProperty(id, "fill-color", "#050f18");
          map.setPaintProperty(id, "fill-opacity", 0.95);
        } else if (lo.includes("industrial") || lo.includes("commercial")) {
          map.setPaintProperty(id, "fill-color", "#060d1c");
          map.setPaintProperty(id, "fill-opacity", 0.9);
        } else {
          map.setPaintProperty(id, "fill-color", "#060e1c");
          map.setPaintProperty(id, "fill-opacity", 0.95);
        }
      } else if (layer.type === "line") {
        if (lo.includes("water") || lo.includes("river") || lo.includes("stream")) {
          map.setPaintProperty(id, "line-color", "#06101e");
        } else if (lo.includes("motorway") || lo.includes("trunk")) {
          map.setPaintProperty(id, "line-color", "#142d52");
          try { map.setPaintProperty(id, "line-width", ["*", ["get", "line-width"], 1.2]); } catch {}
        } else if (lo.includes("primary")) {
          map.setPaintProperty(id, "line-color", "#0d2240");
        } else if (lo.includes("secondary") || lo.includes("tertiary")) {
          map.setPaintProperty(id, "line-color", "#0a1b32");
        } else if (lo.includes("residential") || lo.includes("road") || lo.includes("street")) {
          map.setPaintProperty(id, "line-color", "#081525");
        } else {
          map.setPaintProperty(id, "line-color", "#060d1c");
        }
      } else if (layer.type === "symbol") {
        // Make major place labels visible in cyan-tinted white
        if (lo.includes("place") || lo.includes("city") || lo.includes("town") || lo.includes("suburb") || lo.includes("quarter") || lo.includes("neighbourhood") || lo.includes("state")) {
          try { map.setPaintProperty(id, "text-color", "#4db8d4"); } catch {}
          try { map.setPaintProperty(id, "text-halo-color", "#020811"); } catch {}
          try { map.setPaintProperty(id, "text-halo-width", 1.5); } catch {}
          try { map.setPaintProperty(id, "text-opacity", 0.85); } catch {}
        } else if (lo.includes("road") || lo.includes("street") || lo.includes("highway")) {
          try { map.setPaintProperty(id, "text-color", "#1a3a55"); } catch {}
          try { map.setPaintProperty(id, "text-opacity", 0.4); } catch {}
        } else if (lo.includes("poi") || lo.includes("landmark") || lo.includes("building")) {
          try { map.setPaintProperty(id, "text-color", "#2d7a9a"); } catch {}
          try { map.setPaintProperty(id, "text-halo-color", "#020811"); } catch {}
          try { map.setPaintProperty(id, "text-opacity", 0.6); } catch {}
        } else {
          try { map.setPaintProperty(id, "text-color", "#1a3a55"); } catch {}
          try { map.setPaintProperty(id, "text-halo-color", "#020811"); } catch {}
          try { map.setPaintProperty(id, "text-opacity", 0.45); } catch {}
          try { map.setPaintProperty(id, "icon-opacity", 0.25); } catch {}
        }
      } else if (layer.type === "fill-extrusion") {
        // Hide the style's default flat/low-quality building extrusions;
        // we replace them with our own hero-bldg/hero-roof layers below.
        map.setPaintProperty(id, "fill-extrusion-opacity", 0);
      } else if ((layer.type as string) === "fill" && lo.includes("building")) {
        map.setPaintProperty(id, "fill-opacity", 0);
      }
    } catch { /* non-fatal */ }
  });
}

const BUILDING_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"],
  ["coalesce", ["get", "render_height"], ["get", "height"], 4],
  0, "#060e1e", 6, "#07152a", 15, "#0a2440",
  30, "#0c3b63", 55, "#0b5285", 85, "#0a72a8",
  120, "#0891b2", 170, "#06b6d4", 250, "#22d3ee",
];

const ROOF_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"],
  ["coalesce", ["get", "render_height"], ["get", "height"], 4],
  0, "#0c1d30", 20, "#143860", 55, "#1670a0",
  110, "#1a98c8", 190, "#38bdf8", 300, "#93c5fd",
];

// ── 8 Demo flights across NYC ─────────────────────────────────────────────────
const DEMO_FLIGHTS = [
  { id: "ALT-001", origin: [-74.013, 40.706] as [number,number], dest: [-73.944, 40.803] as [number,number], color: "#2dd4bf", duration: 28000, delay: 0,     alt: 850,  speed: 94 },
  { id: "ALT-002", origin: [-73.986, 40.757] as [number,number], dest: [-74.044, 40.685] as [number,number], color: "#f59e0b", duration: 24000, delay: 5000,  alt: 620,  speed: 88 },
  { id: "ALT-003", origin: [-73.935, 40.730] as [number,number], dest: [-73.993, 40.768] as [number,number], color: "#a78bfa", duration: 20000, delay: 10000, alt: 1100, speed: 102 },
  { id: "ALT-004", origin: [-73.960, 40.780] as [number,number], dest: [-73.997, 40.720] as [number,number], color: "#34d399", duration: 26000, delay: 3000,  alt: 750,  speed: 91 },
  { id: "ALT-005", origin: [-74.002, 40.740] as [number,number], dest: [-73.950, 40.810] as [number,number], color: "#f472b6", duration: 22000, delay: 8000,  alt: 480,  speed: 85 },
  { id: "ALT-006", origin: [-73.975, 40.695] as [number,number], dest: [-73.920, 40.745] as [number,number], color: "#fb923c", duration: 30000, delay: 14000, alt: 930,  speed: 97 },
  { id: "ALT-007", origin: [-74.030, 40.720] as [number,number], dest: [-73.965, 40.790] as [number,number], color: "#60a5fa", duration: 25000, delay: 18000, alt: 1350, speed: 110 },
  { id: "ALT-008", origin: [-73.945, 40.760] as [number,number], dest: [-74.010, 40.700] as [number,number], color: "#e879f9", duration: 21000, delay: 22000, alt: 560,  speed: 87 },
];

// ── NYC city tour waypoints ───────────────────────────────────────────────────
const CITY_VIEWS = [
  { center: [-73.9857, 40.7484] as [number,number], zoom: 15.8, pitch: 78, bearing: -15, label: "Midtown Manhattan" },
  { center: [-74.0132, 40.7062] as [number,number], zoom: 15.5, pitch: 76, bearing: 30,  label: "Lower Manhattan" },
  { center: [-73.9496, 40.6501] as [number,number], zoom: 15.2, pitch: 72, bearing: -40, label: "Brooklyn" },
  { center: [-73.9442, 40.7282] as [number,number], zoom: 15.4, pitch: 75, bearing: 20,  label: "Queens" },
  { center: [-73.9772, 40.7831] as [number,number], zoom: 15.6, pitch: 77, bearing: -25, label: "Upper West Side" },
];

// ─────────────────────────────────────────────────────────────────────────────
export default function LiveMapSection() {
  const mapContainer   = useRef<HTMLDivElement>(null);
  const mapRef         = useRef<maplibregl.Map | null>(null);
  const animRefs       = useRef<number[]>([]);
  const tourRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rotateRef      = useRef<number | null>(null);
  const userInteracted = useRef(false);
  const navigate       = useNavigate();

  const [ready,          setReady]          = useState(false);
  const [activeFlights,  setActiveFlights]  = useState(0);
  const [clock,          setClock]          = useState("");
  const [cityLabel,      setCityLabel]      = useState("New York City");
  const [cityIdx,        setCityIdx]        = useState(0);
  const [liveFlights,    setLiveFlights]    = useState<{ id: string; alt: number; speed: number; color: string }[]>([]);

  // Real-time clock
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Live telemetry — jitter altitude/speed slightly every 2s for realism
  useEffect(() => {
    if (!ready) return;
    const update = () => {
      setLiveFlights(DEMO_FLIGHTS.map((f) => ({
        id: f.id,
        color: f.color,
        alt:   Math.round(f.alt   + (Math.random() - 0.5) * 40),
        speed: Math.round(f.speed + (Math.random() - 0.5) * 8),
      })));
    };
    update();
    const id = setInterval(update, 2000);
    return () => clearInterval(id);
  }, [ready]);

  useEffect(() => {
    if (!document.getElementById("altos-hero-kf")) {
      const s = document.createElement("style");
      s.id = "altos-hero-kf";
      s.textContent = `
        @keyframes altos-hero-pulse {
          0%   { transform:scale(1);   opacity:0.8; }
          70%  { transform:scale(2.6); opacity:0;   }
          100% { transform:scale(2.6); opacity:0;   }
        }
        .maplibregl-ctrl-group { display:none!important; }
        .maplibregl-ctrl-attrib { opacity:0.15!important; font-size:9px!important; }
      `;
      document.head.appendChild(s);
    }

    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container:        mapContainer.current,
      style:            "https://tiles.openfreemap.org/styles/liberty",
      center:           CITY_VIEWS[0].center,
      zoom:             CITY_VIEWS[0].zoom,
      pitch:            CITY_VIEWS[0].pitch,
      bearing:          CITY_VIEWS[0].bearing,
      interactive:      true,
      attributionControl: false,
      antialias:        true,
    });

    const stopInteraction = () => { userInteracted.current = true; };
    map.on("mousedown",  stopInteraction);
    map.on("touchstart", stopInteraction);
    map.on("wheel",      stopInteraction);

    map.on("load", () => {
      applyDarkTheme(map);

      (map as any).setFog({
        color:           "#040912",
        "high-color":    "#060d1e",
        "horizon-blend": 0.035,
        "space-color":   "#010407",
        "star-intensity": 0.2,
      } as any);

      // Find the source used by the style's own building layer
      const styleLayers = map.getStyle().layers ?? [];
      const bldgStyleLayer = styleLayers.find(
        (l: any) => l["source-layer"] === "building" || l["source-layer"] === "buildings"
      ) as any;
      const buildingSourceLayer = bldgStyleLayer?.["source-layer"] ?? "building";
      // Prefer the source from the style's own building layer; fall back to first vector source
      const vecSources = Object.entries(map.getStyle().sources);
      const sourceId: string | null =
        bldgStyleLayer?.source ??
        (vecSources.find(([, s]: any) => s.type === "vector")?.[0] ?? null);

      if (sourceId) {
        const H: maplibregl.ExpressionSpecification = [
          "max",
          ["coalesce", ["get", "render_height"], ["get", "height"], ["get", "building:height"], 8],
          8,
        ];
        const scaledH: maplibregl.ExpressionSpecification = ["*", H, 1.4];
        const BASE: maplibregl.ExpressionSpecification = [
          "coalesce", ["get", "render_min_height"], ["get", "min_height"], 0,
        ];

        // 3D building walls
        map.addLayer({
          id: "hero-bldg",
          type: "fill-extrusion",
          source: sourceId,
          "source-layer": buildingSourceLayer,
          minzoom: 12,
          paint: {
            "fill-extrusion-color":   BUILDING_COLOR,
            "fill-extrusion-height":  scaledH,
            "fill-extrusion-base":    BASE,
            "fill-extrusion-opacity": 0.97,
          },
        });
        // Roof cap highlights
        map.addLayer({
          id: "hero-roof",
          type: "fill-extrusion",
          source: sourceId,
          "source-layer": buildingSourceLayer,
          minzoom: 12,
          paint: {
            "fill-extrusion-color":   ROOF_COLOR,
            "fill-extrusion-height":  scaledH,
            "fill-extrusion-base":    ["-", scaledH, 1.5],
            "fill-extrusion-opacity": 0.8,
          },
        });
      }

      // Spawn animated flights
      DEMO_FLIGHTS.forEach((flight, idx) => {
        const pts     = buildRoute(flight.origin, flight.dest, 240, 0.012 + idx * 0.002);
        const routeId = `hr-${idx}`;
        const travId  = `ht-${idx}`;

        map.addSource(routeId, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } } });
        map.addSource(travId,  { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } } });

        map.addLayer({ id: `${routeId}-d`, type: "line", source: routeId, paint: { "line-color": flight.color, "line-width": 1.2, "line-opacity": 0.2, "line-dasharray": [3, 6] } });
        map.addLayer({ id: `${travId}-g`,  type: "line", source: travId, layout: { "line-cap": "round" }, paint: { "line-color": flight.color, "line-width": 7, "line-opacity": 0.18 } });
        map.addLayer({ id: `${travId}-m`,  type: "line", source: travId, layout: { "line-cap": "round" }, paint: { "line-color": flight.color, "line-width": 2.5, "line-opacity": 0.6 } });
        map.addLayer({ id: `${travId}-c`,  type: "line", source: travId, layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 0.9, "line-opacity": 0.85 } });

        const marker = new maplibregl.Marker({ element: createAircraftEl(flight.color), rotationAlignment: "map" })
          .setLngLat(pts[0])
          .addTo(map);

        let startTs: number | null = null;
        const animate = (ts: number) => {
          if (!startTs) startTs = ts;
          const t   = ((ts - startTs) % flight.duration) / flight.duration;
          const i2  = Math.min(Math.floor(t * (pts.length - 1)), pts.length - 2);
          const pos = pts[i2];
          marker.setLngLat(pos);
          marker.setRotation(calcBearing(pos, pts[Math.min(i2 + 8, pts.length - 1)]));
          (map.getSource(travId) as maplibregl.GeoJSONSource)?.setData({
            type: "Feature", properties: {},
            geometry: { type: "LineString", coordinates: pts.slice(0, i2 + 1) },
          });
          animRefs.current[idx] = requestAnimationFrame(animate);
        };

        setTimeout(() => {
          animRefs.current[idx] = requestAnimationFrame(animate);
          setActiveFlights((n) => n + 1);
        }, flight.delay);
      });

      // Slow continuous rotation when user hasn't interacted
      let lastTs = 0;
      const rotateTick = (ts: number) => {
        if (!userInteracted.current) {
          const delta = ts - lastTs;
          if (delta > 16) {
            map.setBearing((map.getBearing() + 0.03) % 360);
            lastTs = ts;
          }
        }
        rotateRef.current = requestAnimationFrame(rotateTick);
      };
      rotateRef.current = requestAnimationFrame(rotateTick);

      // City tour: cycle through views every 14s unless user interacted
      let viewIdx = 0;
      const doTour = () => {
        if (userInteracted.current) return;
        viewIdx = (viewIdx + 1) % CITY_VIEWS.length;
        const v = CITY_VIEWS[viewIdx];
        map.flyTo({ center: v.center, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing, duration: 5000, essential: true });
        setCityLabel(v.label);
        setCityIdx(viewIdx);
        tourRef.current = setTimeout(doTour, 14000);
      };
      tourRef.current = setTimeout(doTour, 14000);

      setReady(true);
    });

    mapRef.current = map;
    return () => {
      animRefs.current.forEach((id) => cancelAnimationFrame(id));
      if (rotateRef.current) cancelAnimationFrame(rotateRef.current);
      if (tourRef.current) clearTimeout(tourRef.current);
      map.remove();
      mapRef.current      = null;
      userInteracted.current = false;
      setReady(false);
      setActiveFlights(0);
    };
  }, []);

  return (
    <section className="relative w-full overflow-hidden" style={{ height: "750px" }}>
      {/* Map canvas */}
      <div ref={mapContainer} className="absolute inset-0" />

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 38%, rgba(4,9,18,0.65) 100%)" }} />

      {/* Top fade */}
      <div className="absolute inset-x-0 top-0 h-28 pointer-events-none"
        style={{ background: "linear-gradient(to bottom, hsl(var(--background)), transparent)" }} />

      {/* Bottom fade */}
      <div className="absolute inset-x-0 bottom-0 h-36 pointer-events-none"
        style={{ background: "linear-gradient(to top, hsl(var(--background)), transparent)" }} />

      {/* ── TOP LEFT: Live status ── */}
      <motion.div
        initial={{ opacity: 0, x: -16 }}
        animate={{ opacity: ready ? 1 : 0, x: ready ? 0 : -16 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="absolute top-6 left-5 z-10 flex flex-col gap-2"
      >
        {/* Live badge */}
        <div className="flex items-center gap-2 bg-black/65 backdrop-blur-md border border-white/10 rounded-xl px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[11px] font-bold font-mono text-white/80 tracking-widest">LIVE AIRSPACE</span>
        </div>
        {/* Clock */}
        <div className="flex items-center gap-2 bg-black/65 backdrop-blur-md border border-white/10 rounded-xl px-3 py-2">
          <Clock className="w-3 h-3 text-cyan-400" />
          <span className="text-[11px] font-mono text-white/70">{clock} UTC</span>
        </div>
        {/* Active flights */}
        <div className="flex items-center gap-2 bg-black/65 backdrop-blur-md border border-white/10 rounded-xl px-3 py-2">
          <Activity className="w-3 h-3 text-cyan-400" />
          <span className="text-[11px] font-mono text-white/70">{activeFlights} ACTIVE · NYC METRO</span>
        </div>
        {/* City label */}
        <AnimatePresence mode="wait">
          <motion.div
            key={cityIdx}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.4 }}
            className="flex items-center gap-2 bg-primary/20 backdrop-blur-md border border-primary/30 rounded-xl px-3 py-2"
          >
            <Navigation className="w-3 h-3 text-primary" />
            <span className="text-[11px] font-mono text-primary font-bold">{cityLabel}</span>
          </motion.div>
        </AnimatePresence>
      </motion.div>

      {/* ── TOP RIGHT: Live flight telemetry ── */}
      <motion.div
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: ready ? 1 : 0, x: ready ? 0 : 16 }}
        transition={{ duration: 0.5, delay: 0.6 }}
        className="absolute top-6 right-5 z-10 bg-black/65 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden"
        style={{ width: 200 }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
          <Plane className="w-3 h-3 text-cyan-400" />
          <span className="text-[10px] font-bold font-mono text-white/50 tracking-widest uppercase">Flight Telemetry</span>
        </div>
        <div className="divide-y divide-white/5 max-h-48 overflow-hidden">
          {liveFlights.slice(0, 6).map((f) => (
            <div key={f.id} className="flex items-center justify-between px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: f.color }} />
                <span className="text-[10px] font-mono text-white/60">{f.id}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-white/40">
                <span>{f.alt}ft</span>
                <span className="text-white/20">·</span>
                <span>{f.speed}kph</span>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ── BOTTOM: Weather strip + CTA ── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: ready ? 1 : 0, y: ready ? 0 : 12 }}
        transition={{ duration: 0.5, delay: 0.9 }}
        className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-4 z-10 px-4"
      >
        {/* Weather / airspace summary strip */}
        <div className="flex items-center gap-3 bg-black/60 backdrop-blur-md border border-white/10 rounded-2xl px-5 py-2.5">
          {[
            { icon: Wind,     label: "Wind",    value: "12 km/h NW" },
            { icon: Activity, label: "Flow",    value: "97% nominal" },
            { icon: Clock,    label: "Slots",   value: "3 available" },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-center gap-2 text-[11px] font-mono">
              <Icon className="w-3 h-3 text-cyan-400/70" />
              <span className="text-white/40">{label}:</span>
              <span className="text-white/70">{value}</span>
              <span className="text-white/10 last:hidden mx-1">|</span>
            </div>
          ))}
        </div>

        <p className="text-[11px] font-mono text-white/25 tracking-widest uppercase">
          Drag · Scroll · Pinch to explore the airspace
        </p>

        <button
          onClick={() => navigate("/plan?test=map")}
          className="flex items-center gap-2.5 bg-primary/95 hover:bg-primary text-primary-foreground
                     px-7 py-3 rounded-xl font-bold text-sm tracking-wide transition-all
                     shadow-[0_0_45px_-4px_hsl(175,70%,45%,0.75)]
                     hover:shadow-[0_0_60px_-4px_hsl(175,70%,45%,0.95)]
                     hover:scale-[1.03] active:scale-[0.97]"
        >
          <Zap className="w-4 h-4" />
          Launch Full 3D Simulation
          <Navigation className="w-4 h-4" />
        </button>
      </motion.div>
    </section>
  );
}
