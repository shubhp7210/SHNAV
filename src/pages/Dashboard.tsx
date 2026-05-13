import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plane, LogOut, Plus, Activity, AlertTriangle,
  TrendingUp, ArrowRight, MapPin, Clock,
  CheckCircle2, AlertCircle, Loader, BarChart3,
  CheckCircle, Zap, Navigation, Shield, Wind,
  Radio, Cpu, Globe, ChevronRight, Home,
} from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { BYPASS_AUTH } from "@/components/AuthGuard";

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

function ScoreRing({ score, size = 52 }: { score: number; size?: number }) {
  const r = size / 2 - 5;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = score >= 80 ? "#34d399" : score >= 60 ? "#fbbf24" : "#f87171";
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg className="absolute inset-0 -rotate-90" width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.9s ease" }} />
      </svg>
      <span className="text-xs font-bold font-mono" style={{ color }}>{score}</span>
    </div>
  );
}

// ── Mini live map ─────────────────────────────────────────────────────────────
function MiniMap() {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-73.9857, 40.7484],
      zoom: 13.5,
      pitch: 62,
      bearing: -20,
      interactive: false,
      attributionControl: false,
      antialias: true,
    });
    map.on("load", () => {
      // Dark theme
      map.getStyle().layers?.forEach((layer: any) => {
        const lo = layer.id.toLowerCase();
        try {
          if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", "#040912");
          else if (layer.type === "fill") {
            if (lo.includes("water")) map.setPaintProperty(layer.id, "fill-color", "#050c1a");
            else if (lo.includes("building")) map.setPaintProperty(layer.id, "fill-opacity", 0);
            else map.setPaintProperty(layer.id, "fill-color", "#060e1c");
          } else if (layer.type === "line") {
            if (lo.includes("motorway")) map.setPaintProperty(layer.id, "line-color", "#142d52");
            else if (lo.includes("primary")) map.setPaintProperty(layer.id, "line-color", "#0d2240");
            else map.setPaintProperty(layer.id, "line-color", "#060d1c");
          } else if (layer.type === "symbol") {
            if (lo.includes("place") || lo.includes("city")) {
              try { map.setPaintProperty(layer.id, "text-color", "#4db8d4"); } catch {}
              try { map.setPaintProperty(layer.id, "text-halo-color", "#020811"); } catch {}
            } else {
              try { map.setPaintProperty(layer.id, "text-opacity", 0); } catch {}
              try { map.setPaintProperty(layer.id, "icon-opacity", 0); } catch {}
            }
          } else if (layer.type === "fill-extrusion") {
            map.setPaintProperty(layer.id, "fill-extrusion-opacity", 0);
          }
        } catch {}
      });

      // 3D buildings
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
            "fill-extrusion-color": ["interpolate", ["linear"],
              ["coalesce", ["get", "render_height"], ["get", "height"], 4],
              0, "#060e1e", 30, "#0c3b63", 80, "#0a72a8", 150, "#06b6d4"],
            "fill-extrusion-height": ["max", ["coalesce", ["get", "render_height"], ["get", "height"], 6], 6],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.9,
          },
        });
      }

      // Animate bearing slowly
      let bearing = -20;
      const tick = () => {
        bearing += 0.015;
        map.setBearing(bearing % 360);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  return <div ref={ref} className="absolute inset-0" />;
}

const ATM_SYSTEMS = [
  { id: "weather",   label: "Weather Intelligence", icon: Wind,   status: "online" },
  { id: "airspace",  label: "Airspace Scheduler",   icon: Radio,  status: "online" },
  { id: "vertiport", label: "Vertiport Coordinator",icon: MapPin, status: "online" },
  { id: "traj",      label: "Trajectory Predictor", icon: Cpu,    status: "online" },
  { id: "decision",  label: "Decision Engine",       icon: Zap,    status: "online" },
];

const fade = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.38, ease: "easeOut" as const } } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };

export default function Dashboard() {
  const { user, signOut, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [flights, setFlights]         = useState<FlightRecord[]>([]);
  const [historical, setHistorical]   = useState<HistoricalFlight[]>([]);
  const [loadingFlights, setLoadingFlights] = useState(true);
  const [decisions, setDecisions]     = useState<{ decision: string; count: number }[]>([]);
  const [activeNav, setActiveNav]     = useState("overview");
  const [clock, setClock]             = useState("");

  // Clock
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
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
    // Active flights only — exclude landed/archived
    supabase
      .from("flight_intents")
      .select("id,aircraft_id,origin,destination,trajectory_score,status,weather_risk,conflicts,created_at")
      .not("status", "in", "(landed,archived)")
      .order("created_at", { ascending: false })
      .limit(12)
      .then(({ data, error }) => {
        if (!error) setFlights((data as FlightRecord[]) ?? []);
        setLoadingFlights(false);
      });

    // Historical / completed flights
    supabase
      .from("historical_flights")
      .select("id,aircraft_id,origin,destination,trajectory_score,weather_risk,conflicts,scheduled_departure,landed_at,archived_at")
      .order("archived_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data) setHistorical(data as HistoricalFlight[]);
      });

    supabase.from("flight_decisions").select("decision").then(({ data }) => {
      if (!data) return;
      const counts: Record<string, number> = {};
      data.forEach((r: any) => { counts[r.decision] = (counts[r.decision] ?? 0) + 1; });
      setDecisions(Object.entries(counts).map(([decision, count]) => ({ decision, count: count as number })));
    });
  }, [user]);

  const handleSignOut = async () => {
    await signOut();
    toast({ title: "Signed out" });
    navigate("/", { replace: true });
  };

  const total      = flights.length;
  const avgScore   = total ? Math.round(flights.reduce((a, f) => a + (f.trajectory_score ?? 0), 0) / total) : null;
  const conflicts  = flights.filter((f) => f.conflicts > 0).length;
  const safeFlights = flights.filter((f) => (f.trajectory_score ?? 0) >= 80).length;
  const activeCount = flights.filter((f) => f.status === "active" || f.status === "analyzing").length;

  const displayName = user?.user_metadata?.operator_name ?? user?.email?.split("@")[0] ?? "Pilot";
  const initials = displayName.slice(0, 2).toUpperCase();

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.5 }}>
          <Plane className="w-6 h-6 text-primary" />
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex overflow-hidden">
      {/* ── Ambient blobs ── */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-48 -left-48 w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -right-40 w-80 h-80 bg-cyan-500/4 rounded-full blur-3xl" />
      </div>

      {/* ── Sidebar ── */}
      <aside className="relative z-20 hidden md:flex flex-col w-56 shrink-0 border-r border-border/40 bg-card/20 backdrop-blur-xl">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 h-16 border-b border-border/30">
          <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
            <Plane className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="font-bold text-sm tracking-tight">Altos UTM</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {[
            { id: "overview", label: "Overview",     icon: Home },
            { id: "flights",  label: "Flights",      icon: Plane },
            { id: "airspace", label: "Live Airspace", icon: Globe },
            { id: "atm",      label: "ATM Systems",  icon: Cpu },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => id === "airspace" ? navigate("/plan?test=map") : setActiveNav(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                activeNav === id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
              {id === "airspace" && <ChevronRight className="w-3 h-3 ml-auto opacity-40" />}
            </button>
          ))}
        </nav>

        {/* Bottom: user + sign out */}
        <div className="p-3 border-t border-border/30">
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-secondary/30 transition-colors group">
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-primary">{initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{displayName}</p>
              <p className="text-[10px] text-muted-foreground truncate">{user?.email ?? "dev mode"}</p>
            </div>
            <button onClick={handleSignOut} className="opacity-0 group-hover:opacity-100 transition-opacity">
              <LogOut className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="flex items-center justify-between px-6 h-16 border-b border-border/30 bg-card/20 backdrop-blur-xl shrink-0 sticky top-0 z-10">
          <div>
            <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">Operations Center</p>
            <h1 className="text-sm font-semibold leading-tight">Welcome back, <span className="text-primary">{displayName}</span></h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/")}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border/40 text-xs font-mono text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            >
              <Home className="w-3.5 h-3.5" />
              Home
            </button>
            <div className="hidden sm:flex items-center gap-2 bg-secondary/40 rounded-xl px-3 py-1.5 border border-border/30">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-mono text-muted-foreground">{clock} UTC</span>
            </div>
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
              onClick={() => navigate("/plan")}
              className="flex items-center gap-2 bg-primary text-primary-foreground rounded-xl px-4 py-2 text-xs font-semibold shadow-lg shadow-primary/25 hover:opacity-90 transition-opacity"
            >
              <Plus className="w-3.5 h-3.5" />
              Plan Flight
            </motion.button>
            {/* Mobile sign out */}
            <button onClick={handleSignOut} className="md:hidden p-2 text-muted-foreground hover:text-foreground">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Page body */}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <motion.div variants={stagger} initial="hidden" animate="show" className="max-w-5xl mx-auto space-y-6">

            {/* ── Row 1: Stats + Mini Map ── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Stats 2×2 */}
              <div className="lg:col-span-2 grid grid-cols-2 gap-3">
                {[
                  { icon: BarChart3,    label: "Total Flights", value: total > 0 ? total : "—",       sub: "submitted plans",    accent: "#06b6d4", bg: "rgba(6,182,212,0.06)" },
                  { icon: TrendingUp,   label: "Avg Score",     value: avgScore ?? "—",                sub: "trajectory safety",  accent: avgScore !== null ? (avgScore >= 80 ? "#34d399" : avgScore >= 60 ? "#fbbf24" : "#f87171") : "#71717a", bg: "rgba(52,211,153,0.06)" },
                  { icon: CheckCircle2, label: "Safe Flights",  value: total > 0 ? safeFlights : "—", sub: "score ≥ 80",          accent: "#34d399", bg: "rgba(52,211,153,0.05)" },
                  { icon: AlertTriangle,label: "Conflicts",     value: total > 0 ? conflicts : "—",   sub: "route conflicts",     accent: conflicts > 0 ? "#f87171" : "#71717a", bg: conflicts > 0 ? "rgba(248,113,113,0.06)" : "rgba(113,113,122,0.05)" },
                ].map(({ icon: Icon, label, value, sub, accent, bg }) => (
                  <motion.div key={label} variants={fade}
                    className="rounded-2xl border border-border/40 p-4 backdrop-blur-sm"
                    style={{ background: bg }}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-mono text-muted-foreground">{label}</span>
                      <div className="w-7 h-7 rounded-lg bg-background/40 flex items-center justify-center">
                        <Icon className="w-3.5 h-3.5" style={{ color: accent }} />
                      </div>
                    </div>
                    <p className="text-3xl font-bold font-mono tracking-tight" style={{ color: accent }}>{value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{sub}</p>
                  </motion.div>
                ))}
              </div>

              {/* Mini live map */}
              <motion.div variants={fade} className="relative rounded-2xl border border-border/40 overflow-hidden min-h-[200px] cursor-pointer group"
                onClick={() => navigate("/plan?test=map")}
              >
                <MiniMap />
                {/* Overlay */}
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(4,9,18,0.55) 100%)" }} />
                <div className="absolute inset-x-0 bottom-0 h-20 pointer-events-none"
                  style={{ background: "linear-gradient(to top, rgba(4,9,18,0.8), transparent)" }} />
                <div className="absolute bottom-3 left-3 right-3">
                  <p className="text-[10px] font-mono text-white/40 tracking-widest uppercase">NYC Metro Airspace</p>
                  <div className="flex items-center justify-between mt-1">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-xs font-mono text-white/70">{activeCount > 0 ? `${activeCount} active` : "All clear"}</span>
                    </div>
                    <span className="text-[10px] font-mono text-primary group-hover:text-primary/80 transition-colors">Open 3D →</span>
                  </div>
                </div>
                <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/50 backdrop-blur-sm rounded-lg px-2 py-1 border border-white/10">
                  <Activity className="w-3 h-3 text-cyan-400" />
                  <span className="text-[10px] font-mono text-white/60">LIVE</span>
                </div>
              </motion.div>
            </div>

            {/* ── Row 2: ATM Decisions + System Health ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* ATM Decision Outcomes */}
              <motion.div variants={fade} className="rounded-2xl border border-border/40 bg-card/20 backdrop-blur-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold">ATM Decision Outcomes</h2>
                  <Shield className="w-4 h-4 text-muted-foreground/50" />
                </div>
                <div className="space-y-3">
                  {[
                    { key: "GO",     label: "Cleared GO",  color: "#34d399", bg: "rgba(52,211,153,0.12)", icon: CheckCircle },
                    { key: "DELAY",  label: "Delayed",     color: "#fbbf24", bg: "rgba(251,191,36,0.12)", icon: Clock },
                    { key: "REROUTE",label: "Rerouted",    color: "#38bdf8", bg: "rgba(56,189,248,0.12)", icon: Navigation },
                  ].map(({ key, label, color, bg, icon: Icon }) => {
                    const count = decisions.find(x => x.decision === key)?.count ?? 0;
                    const totalD = decisions.reduce((a, x) => a + x.count, 0);
                    const pct = totalD > 0 ? (count / totalD) * 100 : 0;
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: bg }}>
                          <Icon className="w-3.5 h-3.5" style={{ color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-mono text-muted-foreground">{label}</span>
                            <span className="text-xs font-bold font-mono" style={{ color }}>{count}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.8, ease: "easeOut" }}
                              className="h-full rounded-full"
                              style={{ background: color }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {decisions.length === 0 && (
                    <p className="text-xs text-muted-foreground font-mono py-2 text-center">No decisions recorded yet</p>
                  )}
                </div>
              </motion.div>

              {/* ATM System Health */}
              <motion.div variants={fade} className="rounded-2xl border border-border/40 bg-card/20 backdrop-blur-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold">System Health</h2>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-[10px] font-mono text-emerald-400">ALL ONLINE</span>
                  </div>
                </div>
                <div className="space-y-2">
                  {ATM_SYSTEMS.map(({ id, label, icon: Icon }) => (
                    <div key={id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-secondary/20 hover:bg-secondary/30 transition-colors">
                      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs font-mono text-foreground/80 flex-1">{label}</span>
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        <span className="text-[10px] font-mono text-emerald-400">online</span>
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>

            {/* ── Row 3: Recent Flights ── */}
            <motion.div variants={fade}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold">Recent Flights</h2>
                <button onClick={() => navigate("/plan")}
                  className="flex items-center gap-1 text-xs text-primary font-mono hover:underline"
                >
                  New flight <ArrowRight className="w-3 h-3" />
                </button>
              </div>

              <div className="rounded-2xl border border-border/40 bg-card/20 backdrop-blur-sm overflow-hidden">
                {loadingFlights ? (
                  <div className="p-12 flex flex-col items-center gap-3">
                    <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}>
                      <Loader className="w-5 h-5 text-muted-foreground" />
                    </motion.div>
                    <span className="text-xs font-mono text-muted-foreground">Loading flights…</span>
                  </div>
                ) : flights.length === 0 ? (
                  <div className="p-16 flex flex-col items-center gap-4 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center">
                      <Plane className="w-7 h-7 text-muted-foreground/30" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">No flights yet</p>
                      <p className="text-muted-foreground text-xs mt-1">Submit your first flight plan to see data here</p>
                    </div>
                    <button onClick={() => navigate("/plan")}
                      className="flex items-center gap-2 bg-primary text-primary-foreground rounded-xl px-5 py-2.5 text-sm font-medium shadow-lg shadow-primary/20"
                    >
                      <Plus className="w-4 h-4" /> Plan your first flight
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Table header */}
                    <div className="hidden sm:grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-5 py-2.5 border-b border-border/30 bg-secondary/10">
                      {["Score", "Route", "Status", "Band", "Date"].map(h => (
                        <span key={h} className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider">{h}</span>
                      ))}
                    </div>
                    <AnimatePresence>
                      <div className="divide-y divide-border/30">
                        {flights.map((f, i) => {
                          const cfg = STATUS_CONFIG[f.status] ?? STATUS_CONFIG.pending;
                          return (
                            <motion.div
                              key={f.id}
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: i * 0.04, duration: 0.3 }}
                              className="flex sm:grid sm:grid-cols-[auto_1fr_auto_auto_auto] gap-4 items-center px-5 py-3.5 hover:bg-secondary/15 transition-colors"
                            >
                              <ScoreRing score={f.trajectory_score ?? 0} size={40} />

                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 text-sm">
                                  <span className="truncate font-medium text-foreground">{f.origin}</span>
                                  <ArrowRight className="w-3 h-3 text-primary shrink-0" />
                                  <span className="truncate text-foreground/80">{f.destination}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  {f.conflicts > 0 && (
                                    <span className="text-[11px] font-mono text-red-400 flex items-center gap-0.5">
                                      <AlertCircle className="w-3 h-3" />{f.conflicts}
                                    </span>
                                  )}
                                  <span className="text-[11px] font-mono text-muted-foreground hidden sm:block">{f.aircraft_id || "—"}</span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                <span className={`text-xs font-mono hidden sm:block ${cfg.color}`}>{cfg.label}</span>
                              </div>

                              <span className="text-[11px] font-mono text-muted-foreground/60 hidden sm:block uppercase tracking-wide">{f.weather_risk}</span>

                              <span className="text-[11px] font-mono text-muted-foreground shrink-0">
                                {new Date(f.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </span>
                            </motion.div>
                          );
                        })}
                      </div>
                    </AnimatePresence>
                  </>
                )}
              </div>
            </motion.div>

          </motion.div>
        </main>
      </div>
    </div>
  );
}
