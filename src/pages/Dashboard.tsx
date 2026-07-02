import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plane, LogOut, Plus, Activity, AlertTriangle,
  TrendingUp, ArrowRight, Clock, BarChart3,
  CheckCircle2, AlertCircle, Loader,
  CheckCircle, Navigation, Shield, Wind,
  Radio, Cpu, MapPin, Zap, ChevronRight, Home,
} from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { BYPASS_AUTH } from "@/components/AuthGuard";

// ── Types ─────────────────────────────────────────────────────────────────────
interface FlightRecord {
  id: string;
  aircraft_id: string;
  origin: string;
  destination: string;
  trajectory_score: number;
  status: string;
  weather_risk: string;
  conflicts: number;
  created_at: string;
}
interface HistoricalFlight {
  id: string;
  aircraft_id: string;
  origin: string;
  destination: string;
  trajectory_score: number;
  weather_risk: string | null;
  conflicts: number;
  scheduled_departure: string | null;
  landed_at: string | null;
  archived_at: string;
}
interface Vertiport {
  name: string;
  lat: number;
  lon: number;
}
interface MapRoute {
  from: [number, number];
  to: [number, number];
  status: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  pending:   { label: "Pending",   color: "text-amber-400",   dot: "bg-amber-400" },
  scheduled: { label: "Scheduled", color: "text-sky-400",     dot: "bg-sky-400" },
  approved:  { label: "Approved",  color: "text-emerald-400", dot: "bg-emerald-400" },
  boarding:  { label: "Boarding",  color: "text-violet-400",  dot: "bg-violet-400 animate-pulse" },
  in_air:    { label: "In Air",    color: "text-cyan-400",    dot: "bg-cyan-400 animate-pulse" },
  active:    { label: "Active",    color: "text-cyan-400",    dot: "bg-cyan-400 animate-pulse" },
  analyzing: { label: "Analyzing", color: "text-blue-400",    dot: "bg-blue-400 animate-pulse" },
  landed:    { label: "Landed",    color: "text-zinc-400",    dot: "bg-zinc-400" },
  archived:  { label: "Archived",  color: "text-zinc-500",    dot: "bg-zinc-500" },
  completed: { label: "Completed", color: "text-zinc-500",    dot: "bg-zinc-500" },
};

const ATM_SYSTEMS = [
  { id: "weather",   label: "Weather Intel",      icon: Wind,   },
  { id: "airspace",  label: "Airspace Scheduler", icon: Radio,  },
  { id: "vertiport", label: "Vertiport Coord.",   icon: MapPin, },
  { id: "traj",      label: "Trajectory Pred.",   icon: Cpu,    },
  { id: "decision",  label: "Decision Engine",    icon: Zap,    },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildArc(from: [number, number], to: [number, number]): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const arc = Math.sin(t * Math.PI) * 0.008;
    pts.push([from[0] + (to[0] - from[0]) * t + arc * 0.4, from[1] + (to[1] - from[1]) * t + arc]);
  }
  return pts;
}

function routeColor(status: string): string {
  if (["in_air", "active", "analyzing"].includes(status)) return "#e05644";
  if (["approved", "boarding"].includes(status)) return "rgba(255,255,255,0.65)";
  return "#fbbf24";
}

/** Origins/destinations picked via location search carry "name @ lat,lon". */
function parseTaggedCoords(loc: string): { lat: number; lon: number } | null {
  const m = loc?.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const r = size / 2 - 5;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = score >= 80 ? "#34d399" : score >= 60 ? "#fbbf24" : "#f87171";
  return (
    <div className="relative flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
      <svg className="absolute inset-0 -rotate-90" width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="3" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.9s ease" }} />
      </svg>
      <span className="text-[11px] font-bold font-mono" style={{ color }}>{score}</span>
    </div>
  );
}

// ── Map component ─────────────────────────────────────────────────────────────
function OpsMap({ interactive = false, routes }: { interactive?: boolean; routes?: MapRoute[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Also held in state so the route-drawing effect re-runs once the map is
  // ready — init can happen after routes arrive (ResizeObserver defers it).
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    let disposed = false;
    let rotationRaf: number | null = null;

    const init = () => {
      if (!ref.current || mapRef.current || disposed) return;
      const { width, height } = ref.current.getBoundingClientRect();
      if (width === 0 || height === 0) return; // wait for real dimensions

      const map = new maplibregl.Map({
        container: ref.current,
        style: "https://tiles.openfreemap.org/styles/bright",
        center: [-73.9857, 40.7484],
        zoom: interactive ? 12 : 13.5,
        pitch: interactive ? 45 : 62,
        bearing: -20,
        interactive,
        attributionControl: false,
        antialias: true,
      });

      map.on("load", () => {
        map.resize();

        const bldgLayer = map.getStyle().layers?.find((l: any) => l["source-layer"] === "building") as any;
        const srcId = bldgLayer?.source;
        if (srcId) {
          map.addLayer({
            id: "db-bldg",
            type: "fill-extrusion",
            source: srcId,
            "source-layer": "building",
            minzoom: 12,
            paint: {
              "fill-extrusion-color": "#aaa",
              "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 6],
              "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
              "fill-extrusion-opacity": 0.7,
            },
          });
        }

        if (!interactive) {
          let bearing = -20;
          const tick = () => {
            if (disposed) return;
            bearing += 0.015;
            map.setBearing(bearing % 360);
            rotationRaf = requestAnimationFrame(tick);
          };
          rotationRaf = requestAnimationFrame(tick);
        }
      });

      mapRef.current = map;
      setMapInstance(map);
    };

    // Try immediately, then watch for the container to get real size
    init();
    const ro = new ResizeObserver(() => {
      if (!mapRef.current) init();
      else mapRef.current.resize();
    });
    ro.observe(ref.current);

    return () => {
      disposed = true;
      if (rotationRaf !== null) cancelAnimationFrame(rotationRaf);
      ro.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      setMapInstance(null);
    };
  }, [interactive]);

  // Draw flight paths when routes data arrives (or when the map becomes ready)
  useEffect(() => {
    const map = mapInstance;
    if (!map || !routes?.length) return;

    const layerIds: string[] = [];
    const sourceIds: string[] = [];

    const draw = () => {
      // Clean up any previous route layers first
      layerIds.forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch {} });
      sourceIds.forEach(id => { try { if (map.getSource(id)) map.removeSource(id); } catch {} });
      layerIds.length = 0;
      sourceIds.length = 0;

      routes.forEach((r, i) => {
        const pts   = buildArc(r.from, r.to);
        const color = routeColor(r.status);
        const srcId  = `fp-src-${i}`;
        const glowId = `fp-glow-${i}`;
        const lineId = `fp-line-${i}`;

        map.addSource(srcId, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } } });
        map.addLayer({ id: glowId, type: "line", source: srcId, layout: { "line-cap": "round" }, paint: { "line-color": color, "line-width": 8, "line-opacity": 0.12 } });
        map.addLayer({ id: lineId, type: "line", source: srcId, layout: { "line-cap": "round" }, paint: { "line-color": color, "line-width": 1.5, "line-opacity": 0.75, "line-dasharray": [4, 4] } });

        layerIds.push(glowId, lineId);
        sourceIds.push(srcId);
      });
    };

    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);

    return () => {
      map.off("load", draw);
      if (mapRef.current !== map) return; // map already removed
      layerIds.forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch {} });
      sourceIds.forEach(id => { try { if (map.getSource(id)) map.removeSource(id); } catch {} });
    };
  }, [routes, mapInstance]);

  return (
    <div ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
type Tab = "overview" | "flights" | "history";

export default function Dashboard() {
  const { user, signOut, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>("overview");
  const [flights, setFlights] = useState<FlightRecord[]>([]);
  const [historical, setHistorical] = useState<HistoricalFlight[]>([]);
  const [loadingFlights, setLoadingFlights] = useState(true);
  const [decisions, setDecisions] = useState<{ decision: string; count: number }[]>([]);
  const [selectedFlight, setSelectedFlight] = useState<FlightRecord | null>(null);
  const [clock, setClock] = useState("");
  const [vertiportMap, setVertiportMap] = useState<Record<string, { lat: number; lon: number }>>({});

  useEffect(() => {
    // Displayed with a "UTC" label — format in UTC, not local time.
    const tick = () => setClock(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (BYPASS_AUTH) return;
    if (!authLoading && !user) navigate("/auth", { replace: true });
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!user && !BYPASS_AUTH) return;
    let cancelled = false;
    setLoadingFlights(true);

    const load = async () => {
      try {
        const [intentsRes, historicalRes, decisionsRes, vertiportsRes] = await Promise.allSettled([
          supabase.from("flight_intents")
            .select("id,aircraft_id,origin,destination,trajectory_score,status,weather_risk,conflicts,created_at")
            .not("status", "in", "(landed,archived)")
            .order("created_at", { ascending: false })
            .limit(12),
          supabase.from("historical_flights")
            .select("id,aircraft_id,origin,destination,trajectory_score,weather_risk,conflicts,scheduled_departure,landed_at,archived_at")
            .order("archived_at", { ascending: false })
            .limit(30),
          supabase.from("flight_decisions").select("decision"),
          supabase.from("vertiports").select("name,lat,lon").eq("is_active", true),
        ]);
        if (cancelled) return;

        if (intentsRes.status === "fulfilled" && !intentsRes.value.error)
          setFlights((intentsRes.value.data as FlightRecord[]) ?? []);
        if (historicalRes.status === "fulfilled" && !historicalRes.value.error)
          setHistorical((historicalRes.value.data as HistoricalFlight[]) ?? []);
        if (decisionsRes.status === "fulfilled" && !decisionsRes.value.error) {
          const counts: Record<string, number> = {};
          decisionsRes.value.data?.forEach((r: { decision: string }) => {
            counts[r.decision] = (counts[r.decision] ?? 0) + 1;
          });
          setDecisions(Object.entries(counts).map(([decision, count]) => ({ decision, count: count as number })));
        }
        if (vertiportsRes.status === "fulfilled" && !vertiportsRes.value.error) {
          const lookup: Record<string, { lat: number; lon: number }> = {};
          (vertiportsRes.value.data as Vertiport[])?.forEach((v) => { lookup[v.name] = { lat: v.lat, lon: v.lon }; });
          setVertiportMap(lookup);
        }
      } finally {
        if (!cancelled) setLoadingFlights(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [user, toast]);

  const handleSignOut = async () => {
    await signOut();
    navigate("/", { replace: true });
  };

  const total       = flights.length;
  const avgScore    = total ? Math.round(flights.reduce((a, f) => a + (f.trajectory_score ?? 0), 0) / total) : null;
  const conflicts   = flights.filter((f) => f.conflicts > 0).length;
  const safeFlights = flights.filter((f) => (f.trajectory_score ?? 0) >= 80).length;
  const activeCount = flights.filter((f) => ["active", "analyzing", "in_air"].includes(f.status)).length;
  const displayName = user?.user_metadata?.operator_name ?? user?.email?.split("@")[0] ?? "Pilot";
  const initials    = displayName.slice(0, 2).toUpperCase();

  const mapRoutes = useMemo<MapRoute[]>(() => {
    return flights.flatMap((f) => {
      // Prefer the coordinates embedded in geocoded locations; exact
      // vertiport-name match is only a fallback (origins are free text).
      const from = parseTaggedCoords(f.origin) ?? vertiportMap[f.origin];
      const to   = parseTaggedCoords(f.destination) ?? vertiportMap[f.destination];
      if (!from || !to) return [];
      return [{ from: [from.lon, from.lat] as [number, number], to: [to.lon, to.lat] as [number, number], status: f.status }];
    });
  }, [flights, vertiportMap]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.5 }}>
          <Plane className="w-5 h-5 text-primary" />
        </motion.div>
      </div>
    );
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "flights",  label: "Flights" },
    { id: "history",  label: "History" },
  ];

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">

      {/* ── Top bar ── */}
      <header className="shrink-0 h-14 border-b border-border/30 bg-card/25 backdrop-blur-xl flex items-center px-4 gap-3 z-20">
        {/* Home + Logo */}
        <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mr-1" title="Back to home">
          <Home className="w-4 h-4" />
        </Link>
        <span className="font-bold text-sm tracking-[0.18em] text-primary mr-2 select-none">SHNAV</span>

        {/* Tabs */}
        <nav className="flex items-center gap-0.5 flex-1">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`relative px-3.5 py-1.5 text-[12px] font-medium rounded-full transition-colors ${
                tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === id && (
                <motion.span
                  layoutId="tab-pill"
                  className="absolute inset-0 rounded-full bg-white/7 border border-white/10"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <span className="relative">{label}</span>
            </button>
          ))}
        </nav>

        {/* Right: clock + user + plan btn */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            {clock} UTC
          </div>
          <button
            onClick={() => navigate("/plan")}
            className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Plan Flight</span>
          </button>
          <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center cursor-pointer hover:bg-primary/25 transition-colors group relative">
            <span className="text-xs font-bold text-primary">{initials}</span>
            <button
              onClick={handleSignOut}
              className="absolute inset-0 flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 bg-background/80 transition-opacity"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Tab panels ── */}
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">

          {/* ═══ OVERVIEW ═══ */}
          {tab === "overview" && (
            <motion.div
              key="overview"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="h-full flex"
              style={{ height: "calc(100vh - 56px)" }}
            >
              {/* Left: live map (60%) */}
              <div className="relative flex-[3] min-w-0">
                <OpsMap routes={mapRoutes} />
                {/* Map overlays */}
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(4,9,18,0.45) 100%)" }} />
                <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm rounded-lg px-2.5 py-1.5 border border-white/10 pointer-events-none">
                  <Activity className="w-3 h-3 text-primary" />
                  <span className="text-[10px] font-mono text-white/70 tracking-widest">NYC METRO · LIVE</span>
                </div>
                <div className="absolute bottom-3 left-3 pointer-events-none">
                  <div className="flex items-center gap-1.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${activeCount > 0 ? "bg-primary animate-pulse" : "bg-emerald-400"}`} />
                    <span className="text-xs font-mono text-white/60">{activeCount > 0 ? `${activeCount} active` : "All clear"}</span>
                  </div>
                </div>
              </div>

              {/* Right: stats + decisions + recent (40%) */}
              <div className="flex-[2] min-w-0 border-l border-border/30 overflow-y-auto bg-background/60 backdrop-blur-xl">
                <div className="p-4 space-y-4">

                  {/* 4 stats */}
                  <div className="grid grid-cols-2 gap-2.5">
                    {[
                      { icon: BarChart3,    label: "Flights",    value: total || "—",       color: "#06b6d4" },
                      { icon: TrendingUp,   label: "Avg Score",  value: avgScore ?? "—",    color: avgScore !== null ? (avgScore >= 80 ? "#34d399" : avgScore >= 60 ? "#fbbf24" : "#f87171") : "#71717a" },
                      { icon: CheckCircle2, label: "Safe",       value: total ? safeFlights : "—", color: "#34d399" },
                      { icon: AlertTriangle,label: "Conflicts",  value: total ? conflicts : "—", color: conflicts > 0 ? "#f87171" : "#71717a" },
                    ].map(({ icon: Icon, label, value, color }) => (
                      <div key={label} className="glass-card rounded-xl p-3.5">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{label}</span>
                          <Icon className="w-3.5 h-3.5" style={{ color }} />
                        </div>
                        <p className="text-2xl font-bold font-mono" style={{ color }}>{value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Decision outcomes */}
                  <div className="glass-card rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold">Decision Outcomes</span>
                      <Shield className="w-3.5 h-3.5 text-muted-foreground/40" />
                    </div>
                    <div className="space-y-2.5">
                      {[
                        { key: "GO",      label: "Cleared GO", color: "#34d399", icon: CheckCircle },
                        { key: "DELAY",   label: "Delayed",    color: "#fbbf24", icon: Clock },
                        { key: "REROUTE", label: "Rerouted",   color: "#38bdf8", icon: Navigation },
                      ].map(({ key, label, color, icon: Icon }) => {
                        const count  = decisions.find(x => x.decision === key)?.count ?? 0;
                        const totalD = decisions.reduce((a, x) => a + x.count, 0);
                        const pct    = totalD > 0 ? (count / totalD) * 100 : 0;
                        return (
                          <div key={key} className="flex items-center gap-2.5">
                            <Icon className="w-3.5 h-3.5 shrink-0" style={{ color }} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
                                <span className="text-[11px] font-bold font-mono" style={{ color }}>{count}</span>
                              </div>
                              <div className="h-1 rounded-full bg-secondary/60 overflow-hidden">
                                <motion.div
                                  initial={{ width: 0 }}
                                  animate={{ width: `${pct}%` }}
                                  transition={{ duration: 0.9, ease: "easeOut" }}
                                  className="h-full rounded-full"
                                  style={{ background: color }}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {decisions.length === 0 && (
                        <p className="text-[11px] font-mono text-muted-foreground text-center py-1">No decisions yet</p>
                      )}
                    </div>
                  </div>

                  {/* System health */}
                  <div className="glass-card rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold">ATM Systems</span>
                      <div className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-[10px] font-mono text-emerald-400">ALL ONLINE</span>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      {ATM_SYSTEMS.map(({ id, label, icon: Icon }) => (
                        <div key={id} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg bg-secondary/20">
                          <Icon className="w-3 h-3 text-muted-foreground shrink-0" />
                          <span className="text-[11px] font-mono text-foreground/75 flex-1">{label}</span>
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Recent flights */}
                  <div>
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="text-xs font-semibold">Recent Flights</span>
                      <button onClick={() => setTab("flights")} className="text-[11px] font-mono text-primary hover:underline flex items-center gap-0.5">
                        All <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                    {loadingFlights ? (
                      <div className="flex items-center gap-2 py-4 justify-center">
                        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}>
                          <Loader className="w-4 h-4 text-muted-foreground" />
                        </motion.div>
                        <span className="text-[11px] font-mono text-muted-foreground">Loading…</span>
                      </div>
                    ) : flights.length === 0 ? (
                      <div className="glass-card rounded-xl p-5 text-center">
                        <Plane className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
                        <p className="text-xs text-muted-foreground">No flights yet</p>
                        <button onClick={() => navigate("/plan")} className="mt-3 text-xs text-primary hover:underline font-mono">
                          Plan your first flight →
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {flights.slice(0, 4).map((f) => {
                          const cfg = STATUS_CONFIG[f.status] ?? STATUS_CONFIG.pending;
                          return (
                            <button
                              key={f.id}
                              onClick={() => { setTab("flights"); setSelectedFlight(f); }}
                              className="w-full glass-card rounded-xl px-3.5 py-3 flex items-center gap-3 hover:border-primary/20 transition-colors text-left"
                            >
                              <ScoreRing score={f.trajectory_score ?? 0} size={38} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1 text-[12px]">
                                  <span className="font-medium truncate">{f.origin}</span>
                                  <ArrowRight className="w-3 h-3 text-primary shrink-0" />
                                  <span className="truncate text-foreground/70">{f.destination}</span>
                                </div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                  <span className={`text-[10px] font-mono ${cfg.color}`}>{cfg.label}</span>
                                  {f.conflicts > 0 && (
                                    <span className="text-[10px] font-mono text-red-400 flex items-center gap-0.5">
                                      <AlertCircle className="w-2.5 h-2.5" />{f.conflicts}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                </div>
              </div>
            </motion.div>
          )}

          {/* ═══ FLIGHTS ═══ */}
          {tab === "flights" && (
            <motion.div
              key="flights"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="relative"
              style={{ height: "calc(100vh - 56px)" }}
            >
              <OpsMap interactive />

              {/* Gradient vignette */}
              <div className="absolute inset-0 pointer-events-none"
                style={{ background: "radial-gradient(ellipse at center, transparent 35%, rgba(4,9,18,0.3) 100%)" }} />

              {/* Floating flight list — left */}
              <div className="absolute left-3 top-3 bottom-3 w-64 flex flex-col gap-2 pointer-events-none">
                <div className="glass-panel rounded-2xl flex flex-col overflow-hidden pointer-events-auto" style={{ maxHeight: "100%" }}>
                  <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between shrink-0">
                    <span className="text-xs font-semibold">Active Flights</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{flights.length} plans</span>
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {loadingFlights ? (
                      <div className="flex items-center justify-center gap-2 p-6">
                        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}>
                          <Loader className="w-4 h-4 text-muted-foreground" />
                        </motion.div>
                      </div>
                    ) : flights.length === 0 ? (
                      <div className="p-6 text-center">
                        <Plane className="w-5 h-5 text-muted-foreground/30 mx-auto mb-2" />
                        <p className="text-[11px] text-muted-foreground">No active flights</p>
                        <button onClick={() => navigate("/plan")} className="mt-2 text-[11px] text-primary hover:underline font-mono">
                          Plan a flight →
                        </button>
                      </div>
                    ) : (
                      <div className="divide-y divide-border/20">
                        {flights.map((f) => {
                          const cfg = STATUS_CONFIG[f.status] ?? STATUS_CONFIG.pending;
                          const sel = selectedFlight?.id === f.id;
                          return (
                            <button
                              key={f.id}
                              onClick={() => setSelectedFlight(sel ? null : f)}
                              className={`w-full px-3.5 py-3 text-left transition-colors ${sel ? "bg-primary/10" : "hover:bg-secondary/30"}`}
                            >
                              <div className="flex items-center gap-2.5">
                                <ScoreRing score={f.trajectory_score ?? 0} size={36} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-[11px] font-medium truncate">{f.origin} → {f.destination}</p>
                                  <div className="flex items-center gap-1.5 mt-0.5">
                                    <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                    <span className={`text-[10px] font-mono ${cfg.color}`}>{cfg.label}</span>
                                  </div>
                                </div>
                                {sel && <ChevronRight className="w-3 h-3 text-primary shrink-0" />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 p-3 border-t border-border/30">
                    <button onClick={() => navigate("/plan")}
                      className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg py-2 text-xs font-semibold hover:bg-primary/90 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> New Flight Plan
                    </button>
                  </div>
                </div>
              </div>

              {/* Floating detail panel — right */}
              <AnimatePresence>
                {selectedFlight && (
                  <motion.div
                    key={selectedFlight.id}
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 16 }}
                    transition={{ duration: 0.22 }}
                    className="absolute right-3 top-3 w-72 glass-panel rounded-2xl p-4 space-y-4"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">Flight Details</p>
                        <p className="text-sm font-semibold">{selectedFlight.origin}</p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <ArrowRight className="w-3 h-3 text-primary" />
                          <p className="text-sm text-foreground/70">{selectedFlight.destination}</p>
                        </div>
                      </div>
                      <ScoreRing score={selectedFlight.trajectory_score ?? 0} size={48} />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: "Aircraft",  value: selectedFlight.aircraft_id || "—" },
                        { label: "Status",    value: (STATUS_CONFIG[selectedFlight.status] ?? STATUS_CONFIG.pending).label },
                        { label: "Weather",   value: selectedFlight.weather_risk || "—" },
                        { label: "Conflicts", value: String(selectedFlight.conflicts) },
                      ].map(({ label, value }) => (
                        <div key={label} className="bg-secondary/30 rounded-lg px-3 py-2">
                          <p className="text-[10px] font-mono text-muted-foreground">{label}</p>
                          <p className="text-xs font-medium mt-0.5 truncate">{value}</p>
                        </div>
                      ))}
                    </div>

                    <p className="text-[10px] font-mono text-muted-foreground">
                      Submitted {new Date(selectedFlight.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>

                    <button
                      onClick={() => setSelectedFlight(null)}
                      className="w-full text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Dismiss
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Live badge */}
              <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm rounded-lg px-2.5 py-1.5 border border-white/10"
                style={{ right: selectedFlight ? "296px" : "12px" }}>
                <Activity className="w-3 h-3 text-primary" />
                <span className="text-[10px] font-mono text-white/60 tracking-widest">LIVE</span>
              </div>
            </motion.div>
          )}

          {/* ═══ HISTORY ═══ */}
          {tab === "history" && (
            <motion.div
              key="history"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-y-auto"
              style={{ height: "calc(100vh - 56px)" }}
            >
              <div className="max-w-4xl mx-auto px-4 py-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-sm font-semibold">Flight History</h2>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{historical.length} archived flights</p>
                  </div>
                </div>

                {historical.length === 0 ? (
                  <div className="glass-card rounded-2xl p-12 text-center">
                    <Plane className="w-8 h-8 text-muted-foreground/20 mx-auto mb-3" />
                    <p className="text-sm font-medium">No completed flights yet</p>
                    <p className="text-xs text-muted-foreground mt-1">Landed flights will appear here for analytics.</p>
                  </div>
                ) : (
                  <div className="glass-card rounded-2xl overflow-hidden">
                    {/* Header */}
                    <div className="grid grid-cols-[40px_1fr_80px_80px_100px] gap-4 px-5 py-2.5 border-b border-border/30 bg-secondary/10">
                      {["", "Route", "Score", "Weather", "Landed"].map((h, i) => (
                        <span key={i} className="text-[10px] font-mono text-muted-foreground/55 uppercase tracking-wider">{h}</span>
                      ))}
                    </div>
                    <div className="divide-y divide-border/20">
                      {historical.map((h, i) => (
                        <motion.div
                          key={h.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: i * 0.03 }}
                          className="grid grid-cols-[40px_1fr_80px_80px_100px] gap-4 items-center px-5 py-3.5 hover:bg-secondary/10 transition-colors"
                        >
                          <ScoreRing score={h.trajectory_score ?? 0} size={36} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1 text-xs">
                              <span className="font-medium truncate text-foreground/85">{h.origin}</span>
                              <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                              <span className="truncate text-foreground/60">{h.destination}</span>
                            </div>
                            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{h.aircraft_id || "—"}</p>
                          </div>
                          <span className="text-xs font-mono text-muted-foreground">{h.trajectory_score ?? "—"}</span>
                          <span className="text-[11px] font-mono text-muted-foreground capitalize">{h.weather_risk ?? "n/a"}</span>
                          <span className="text-[11px] font-mono text-muted-foreground">
                            {new Date(h.landed_at ?? h.archived_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  );
}
