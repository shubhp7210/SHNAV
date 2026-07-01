import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const FLIGHT_COLOR = "#e05644";

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

function createAircraftEl(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:38px;height:38px;position:relative;pointer-events:none;";
  wrap.innerHTML = `
    <div style="position:absolute;inset:9px;border-radius:50%;background:${FLIGHT_COLOR}44;
      animation:shnav-hero-pulse 2.4s ease-out infinite;"></div>
    <div style="position:absolute;inset:6px;border-radius:50%;
      background:#080c14;
      border:1.5px solid ${FLIGHT_COLOR};
      box-shadow:0 0 12px ${FLIGHT_COLOR}99;
      display:flex;align-items:center;justify-content:center;">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="${FLIGHT_COLOR}"
           style="margin-top:-1px">
        <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8
                 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1
                 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
      </svg>
    </div>`;
  return wrap;
}

const DEMO_FLIGHTS = [
  { id: "ALT-001", origin: [-74.013, 40.706] as [number, number], dest: [-73.944, 40.803] as [number, number], duration: 28000, delay: 0 },
  { id: "ALT-002", origin: [-73.986, 40.757] as [number, number], dest: [-74.044, 40.685] as [number, number], duration: 24000, delay: 5000 },
  { id: "ALT-003", origin: [-73.935, 40.730] as [number, number], dest: [-73.993, 40.768] as [number, number], duration: 20000, delay: 10000 },
  { id: "ALT-004", origin: [-73.960, 40.780] as [number, number], dest: [-73.997, 40.720] as [number, number], duration: 26000, delay: 3000 },
];

export default function LiveMapSection() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const animRefs     = useRef<number[]>([]);
  const navigate     = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!document.getElementById("shnav-hero-kf")) {
      const s = document.createElement("style");
      s.id = "shnav-hero-kf";
      s.textContent = `
        @keyframes shnav-hero-pulse {
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
      container:          mapContainer.current,
      style:              "https://tiles.openfreemap.org/styles/bright",
      center:             [-73.9857, 40.7484],
      zoom:               14.5,
      pitch:              60,
      bearing:            -15,
      interactive:        true,
      attributionControl: false,
      antialias:          true,
    });

    map.on("load", () => {
      map.resize();

      const styleLayers = map.getStyle().layers ?? [];
      const bldgStyleLayer = styleLayers.find(
        (l: any) => l["source-layer"] === "building" || l["source-layer"] === "buildings"
      ) as any;
      const buildingSourceLayer = bldgStyleLayer?.["source-layer"] ?? "building";
      const vecSources = Object.entries(map.getStyle().sources);
      const sourceId: string | null =
        bldgStyleLayer?.source ??
        (vecSources.find(([, s]: any) => s.type === "vector")?.[0] ?? null);

      if (sourceId) {
        map.addLayer({
          id: "3d-buildings",
          type: "fill-extrusion",
          source: sourceId,
          "source-layer": buildingSourceLayer,
          minzoom: 12,
          paint: {
            "fill-extrusion-color": "#aaa",
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 8],
            "fill-extrusion-base":   ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
            "fill-extrusion-opacity": 0.7,
          },
        });
      }

      DEMO_FLIGHTS.forEach((flight, idx) => {
        const pts     = buildRoute(flight.origin, flight.dest, 240, 0.012 + idx * 0.002);
        const routeId = `hr-${idx}`;
        const travId  = `ht-${idx}`;

        map.addSource(routeId, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } } });
        map.addSource(travId,  { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } } });

        map.addLayer({ id: `${routeId}-d`, type: "line", source: routeId, paint: { "line-color": FLIGHT_COLOR, "line-width": 1.2, "line-opacity": 0.2, "line-dasharray": [3, 6] } });
        map.addLayer({ id: `${travId}-g`,  type: "line", source: travId,  layout: { "line-cap": "round" }, paint: { "line-color": FLIGHT_COLOR, "line-width": 7,   "line-opacity": 0.15 } });
        map.addLayer({ id: `${travId}-m`,  type: "line", source: travId,  layout: { "line-cap": "round" }, paint: { "line-color": FLIGHT_COLOR, "line-width": 2.5, "line-opacity": 0.6  } });
        map.addLayer({ id: `${travId}-c`,  type: "line", source: travId,  layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff",     "line-width": 0.9, "line-opacity": 0.85 } });

        const marker = new maplibregl.Marker({ element: createAircraftEl(), rotationAlignment: "map" })
          .setLngLat(pts[0])
          .addTo(map);

        let startTs: number | null = null;
        const animate = (ts: number) => {
          if (!startTs) startTs = ts;
          const t  = ((ts - startTs) % flight.duration) / flight.duration;
          const i2 = Math.min(Math.floor(t * (pts.length - 1)), pts.length - 2);
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
        }, flight.delay);
      });

      setReady(true);
    });

    mapRef.current = map;
    return () => {
      animRefs.current.forEach((id) => cancelAnimationFrame(id));
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  return (
    <section className="relative w-full overflow-hidden" style={{ height: "100vh", minHeight: "600px" }}>
      <div ref={mapContainer} className="absolute inset-0 w-full h-full" />

      {/* Live badge */}
      <motion.div
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: ready ? 1 : 0, x: ready ? 0 : -12 }}
        transition={{ duration: 0.4, delay: 0.3 }}
        className="absolute top-6 left-5 z-10"
      >
        <div className="flex items-center gap-2 bg-zinc-950 border border-white/10 rounded-xl px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[11px] font-bold font-mono text-white/80 tracking-widest">LIVE AIRSPACE</span>
        </div>
      </motion.div>

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: ready ? 1 : 0, y: ready ? 0 : 10 }}
        transition={{ duration: 0.4, delay: 0.5 }}
        className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-3 z-10 px-4"
      >
        <p className="text-[11px] font-mono text-white/30 tracking-widest uppercase">
          Drag, scroll, or pinch to explore
        </p>
        <button
          onClick={() => navigate("/plan?test=map")}
          className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          Try the full simulation
          <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2.5} />
        </button>
      </motion.div>
    </section>
  );
}
