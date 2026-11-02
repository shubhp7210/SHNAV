import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plane, LogOut, Plus, AlertTriangle, TrendingUp, ArrowRight, Clock, BarChart3,
  CheckCircle2, AlertCircle, CheckCircle, Navigation, ChevronRight, MapPin,
  Crosshair, LocateFixed, X, Radio,
} from "lucide-react";
import MapView from "@/components/MapView";
import type { FrameRequest } from "@/components/CesiumMap";
import Logo from "@/components/Logo";
import { MANHATTAN_VIEW, type Pt } from "@/lib/geo/region";
import { locationCoords } from "@/lib/geo/coords";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

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
interface Vertiport { name: string; lat: number; lon: number }
/** A flight that has real coordinates for both ends. */
interface MappedFlight { id: string; poly: Pt[] }

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  pending:   { label: "Pending",   color: "text-caution",       dot: "bg-caution" },
  scheduled: { label: "Scheduled", color: "text-signal",        dot: "bg-signal" },
  approved:  { label: "Approved",  color: "text-success",       dot: "bg-success" },
  boarding:  { label: "Boarding",  color: "text-violet-300",    dot: "bg-violet-300 animate-pulse" },
  in_air:    { label: "In Air",    color: "text-signal",        dot: "bg-signal animate-pulse" },
  active:    { label: "Active",    color: "text-signal",        dot: "bg-signal animate-pulse" },
  analyzing: { label: "Analyzing", color: "text-sky-300",       dot: "bg-sky-300 animate-pulse" },
  landed:    { label: "Landed",    color: "text-muted-foreground", dot: "bg-muted-foreground" },
  archived:  { label: "Archived",  color: "text-muted-foreground", dot: "bg-muted-foreground" },
  completed: { label: "Completed", color: "text-muted-foreground", dot: "bg-muted-foreground" },
};
const statusOf = (s: string) => STATUS_CONFIG[s] ?? STATUS_CONFIG.pending;

/** Strip the "@ lat,lon" geocode tag for display. */
const placeName = (loc: string) => (loc ?? "").replace(/\s*@\s*-?\d+\.?\d*\s*,\s*-?\d+\.?\d*\s*$/, "") || "—";

const scoreColor = (score: number) => (score >= 80 ? "hsl(var(--success))" : score >= 60 ? "hsl(var(--caution))" : "hsl(var(--destructive))");

function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const r = size / 2 - 4;
  const circ = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, score)) / 100) * circ;
  const color = scoreColor(score);
  return (
    <div className="relative flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }} aria-label={`Score ${score}`}>
      <svg className="absolute inset-0 -rotate-90" width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="3" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.9s ease" }} />
      </svg>
      <span className="text-[11px] font-bold font-mono tabular" style={{ color }}>{score}</span>
    </div>
  );
}

function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 justify-center" role="status">
      <span className="w-4 h-4 rounded-full border-2 border-border border-t-signal animate-spin" />
      <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Map ───────────────────────────────────────────────────────────────────────
/** Operations map: always opens on Manhattan. Shows real flights only — when no
 *  flight has coordinates, the map is empty rather than showing invented routes. */
export function OpsMap({
  routes = [], interactive = true, frame,
}: { routes?: Pt[][]; interactive?: boolean; frame?: FrameRequest }) {
  return (
    <MapView
      routes={routes}
      initialView={MANHATTAN_VIEW}
      interactive={interactive}
      frame={frame}
      label="Operations map"
    />
  );
}

function MapControls({ onFrame, onReset, canFrame }: { onFrame: () => void; onReset: () => void; canFrame: boolean }) {
  return (
    <div className="flex items-center gap-1.5 pointer-events-auto">
      <button
        onClick={onFrame}
        disabled={!canFrame}
        className="glass-panel rounded-lg h-9 px-3 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title="Fit all mapped flights"
      >
        <Crosshair className="w-3.5 h-3.5" /> Frame flights
      </button>
      <button
        onClick={onReset}
        className="glass-panel rounded-lg h-9 w-9 flex items-center justify-center text-foreground/80 hover:text-foreground transition-colors"
        title="Reset to Manhattan" aria-label="Reset view to Manhattan"
      >
        <LocateFixed className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── User menu (click-based: works on touch, keyboard-accessible) ─────────────
function UserMenu({ name, email, onSignOut }: { name: string; email?: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} aria-label="Account menu"
        className="w-9 h-9 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center hover:bg-primary/25 transition-colors"
      >
        <span className="text-xs font-bold text-primary">{name.slice(0, 2).toUpperCase()}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 top-11 w-60 glass-panel rounded-xl p-1.5 z-50"
          >
            <div className="px-3 py-2.5 border-b border-border mb-1">
              <p className="text-sm font-semibold truncate">{name}</p>
              {email && <p className="text-[11px] text-muted-foreground truncate">{email}</p>}
            </div>
            <button
              role="menuitem"
              onClick={onSignOut}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground/80 hover:bg-white/5 hover:text-foreground transition-colors"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
type Tab = "overview" | "flights" | "history";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "flights", label: "Flights" },
  { id: "history", label: "History" },
];

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>("overview");
  const [flights, setFlights] = useState<FlightRecord[]>([]);
  const [historical, setHistorical] = useState<HistoricalFlight[]>([]);
  const [loadingFlights, setLoadingFlights] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<{ decision: string; count: number }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState("");
  const [vertiports, setVertiports] = useState<Vertiport[]>([]);
  const [frame, setFrame] = useState<FrameRequest>({ key: 0 });

  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // AuthGuard already redirects signed-out users; this page only loads data.
  useEffect(() => {
    let cancelled = false;
    setLoadingFlights(true);
    const load = async () => {
      try {
        const [intentsRes, historicalRes, decisionsRes, vertiportsRes] = await Promise.allSettled([
          supabase.from("flight_intents")
            .select("id,aircraft_id,origin,destination,trajectory_score,status,weather_risk,conflicts,created_at")
            .not("status", "in", "(landed,archived,expired)")
            .order("created_at", { ascending: false })
            .limit(12),
          supabase.from("historical_flights")
            .select("id,aircraft_id,origin,destination,trajectory_score,weather_risk,conflicts,scheduled_departure,landed_at,archived_at")
            .order("archived_at", { ascending: false })
            .limit(30),
          // Current decision per flight only (re-runs mark older ones superseded).
          supabase.from("flight_decisions").select("decision").eq("superseded", false),
          supabase.from("vertiports").select("name,lat,lon").eq("is_active", true),
        ]);
        if (cancelled) return;

        if (intentsRes.status === "fulfilled" && !intentsRes.value.error) {
          setFlights((intentsRes.value.data as FlightRecord[]) ?? []);
        } else {
          setLoadError("Flight data could not be loaded. Check your connection and refresh.");
        }
        if (historicalRes.status === "fulfilled" && !historicalRes.value.error)
          setHistorical((historicalRes.value.data as HistoricalFlight[]) ?? []);
        if (decisionsRes.status === "fulfilled" && !decisionsRes.value.error) {
          const counts: Record<string, number> = {};
          decisionsRes.value.data?.forEach((r: { decision: string }) => {
            counts[r.decision] = (counts[r.decision] ?? 0) + 1;
          });
          setDecisions(Object.entries(counts).map(([decision, count]) => ({ decision, count })));
        }
        if (vertiportsRes.status === "fulfilled" && !vertiportsRes.value.error)
          setVertiports((vertiportsRes.value.data as Vertiport[]) ?? []);
      } finally {
        if (!cancelled) setLoadingFlights(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [user]);

  const handleSignOut = async () => {
    await signOut();
    navigate("/", { replace: true });
  };

  const total = flights.length;
  const avgScore = total ? Math.round(flights.reduce((a, f) => a + (f.trajectory_score ?? 0), 0) / total) : null;
  const conflicts = flights.filter((f) => f.conflicts > 0).length;
  const safeFlights = flights.filter((f) => (f.trajectory_score ?? 0) >= 80).length;
  const activeCount = flights.filter((f) => ["active", "analyzing", "in_air"].includes(f.status)).length;
  const displayName = user?.user_metadata?.operator_name ?? user?.email?.split("@")[0] ?? "Pilot";
  const totalDecisions = decisions.reduce((a, x) => a + x.count, 0);

  // Real coordinates only: geocoded "@ lat,lon" tags first, exact vertiport
  // names as a fallback. Flights without either are listed but not mapped.
  const mapped = useMemo<MappedFlight[]>(() => {
    const byName: Record<string, Pt> = {};
    vertiports.forEach((v) => { byName[v.name] = { lat: v.lat, lng: v.lon }; });
    const tagged = (loc: string) => (/@/.test(loc) ? locationCoords(loc) : null);
    return flights.flatMap((f) => {
      const a = tagged(f.origin) ?? byName[f.origin];
      const b = tagged(f.destination) ?? byName[f.destination];
      return a && b ? [{ id: f.id, poly: [a, b] }] : [];
    });
  }, [flights, vertiports]);
  const mappedIds = useMemo(() => new Set(mapped.map((m) => m.id)), [mapped]);

  // Selected flight drawn first (routes[0] is highlighted by the renderer).
  const mapRoutes = useMemo<Pt[][]>(() => {
    const sel = mapped.find((m) => m.id === selectedId);
    return sel ? [sel.poly, ...mapped.filter((m) => m !== sel).map((m) => m.poly)] : mapped.map((m) => m.poly);
  }, [mapped, selectedId]);

  const selectedFlight = flights.find((f) => f.id === selectedId) ?? null;
  const frameAll = () => setFrame((f) => ({ key: f.key + 1 }));
  const resetView = () => setFrame((f) => ({ key: f.key + 1, view: MANHATTAN_VIEW }));
  const selectFlight = (id: string | null) => {
    setSelectedId(id);
    const m = mapped.find((x) => x.id === id);
    if (m) setFrame((f) => ({ key: f.key + 1, routes: [m.poly] }));
  };

  const mapOverlay = (
    <>
      <div className="absolute inset-0 pointer-events-none map-vignette" />
      <div className="absolute top-3 left-3 right-3 flex items-start justify-between gap-2 pointer-events-none">
        <div className="glass-panel rounded-lg px-3 py-2 flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${activeCount > 0 ? "bg-signal animate-pulse" : "bg-success"}`} />
          <span className="font-mono text-[10px] tracking-[0.18em] text-foreground/80">MANHATTAN SECTOR</span>
        </div>
        <MapControls onFrame={frameAll} onReset={resetView} canFrame={mapped.length > 0} />
      </div>
      <div className="absolute bottom-3 left-3 pointer-events-none glass-panel rounded-lg px-3 py-2 text-[11px] font-mono text-foreground/70 tabular">
        {loadingFlights ? "Loading flights…" : (
          <>
            {mapped.length} mapped{total - mapped.length > 0 && <span className="text-foreground/45"> · {total - mapped.length} without coordinates</span>}
            {activeCount > 0 && <span className="text-signal"> · {activeCount} active</span>}
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden pb-[calc(52px+env(safe-area-inset-bottom,0px))] md:pb-0">
      {/* ── Top bar ── */}
      <header className="shrink-0 h-14 border-b border-border bg-background/80 backdrop-blur-xl flex items-center px-3 sm:px-4 gap-2 sm:gap-4 z-20">
        <Link to="/" className="flex items-center shrink-0" title="Back to home" aria-label="SHNAV home">
          <Logo size={26} compact showWordmark={false} />
          <span className="hidden lg:inline ml-2 font-display font-semibold text-sm tracking-wide">Operations</span>
        </Link>

        <nav className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto no-scrollbar" aria-label="Dashboard sections">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              className={`relative px-3 sm:px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-colors shrink-0 ${
                tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === id && (
                <motion.span
                  layoutId="tab-pill"
                  className="absolute inset-0 rounded-full bg-white/10 border border-white/10"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <span className="relative">{label}</span>
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden md:flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground tabular" aria-label="UTC time">
            <span className="w-1.5 h-1.5 rounded-full bg-signal animate-pulse" />
            {clock} UTC
          </div>
          <button
            onClick={() => navigate("/plan")}
            className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-full h-9 px-3 sm:px-4 text-xs font-semibold hover:brightness-110 transition"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Plan flight</span>
          </button>
          <UserMenu name={displayName} email={user?.email} onSignOut={handleSignOut} />
        </div>
      </header>

      {loadError && (
        <div className="shrink-0 px-4 py-2 bg-destructive/10 border-b border-destructive/30 text-xs text-destructive flex items-center gap-2" role="alert">
          <AlertCircle className="w-3.5 h-3.5" /> {loadError}
        </div>
      )}

      {/* ── Tab panels ── */}
      <div className="flex-1 min-h-0 relative">
        <AnimatePresence mode="wait" initial={false}>

          {/* ═══ OVERVIEW ═══ */}
          {tab === "overview" && (
            <motion.div
              key="overview"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden"
            >
              <div className="relative shrink-0 h-[46vh] min-h-[300px] lg:h-auto lg:flex-1 lg:min-w-0">
                <OpsMap routes={mapRoutes} frame={frame} />
                {mapOverlay}
              </div>

              <aside className="lg:w-[420px] xl:w-[460px] lg:shrink-0 border-t lg:border-t-0 lg:border-l border-border lg:overflow-y-auto bg-background">
                <div className="p-4 space-y-4">
                  {/* KPI tiles */}
                  <div className="grid grid-cols-2 gap-2.5">
                    {[
                      { icon: BarChart3, label: "Open plans", value: total ? String(total) : "—", color: "hsl(var(--signal))" },
                      { icon: TrendingUp, label: "Avg score", value: avgScore != null ? String(avgScore) : "—", color: avgScore != null ? scoreColor(avgScore) : "hsl(var(--muted-foreground))" },
                      { icon: CheckCircle2, label: "Score ≥ 80", value: total ? String(safeFlights) : "—", color: "hsl(var(--success))" },
                      { icon: AlertTriangle, label: "With conflicts", value: total ? String(conflicts) : "—", color: conflicts > 0 ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))" },
                    ].map(({ icon: Icon, label, value, color }) => (
                      <div key={label} className="panel rounded-xl p-3.5">
                        <div className="flex items-center justify-between mb-2">
                          <span className="label-caps">{label}</span>
                          <Icon className="w-3.5 h-3.5" style={{ color }} />
                        </div>
                        <p className="text-[28px] leading-none font-display font-semibold tabular" style={{ color }}>{value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Decision outcomes */}
                  <section className="panel rounded-xl p-4" aria-labelledby="dec-h">
                    <div className="flex items-center justify-between mb-3">
                      <h3 id="dec-h" className="text-sm font-semibold">Decision outcomes</h3>
                      <span className="label-caps tabular">{totalDecisions} total</span>
                    </div>
                    {totalDecisions === 0 ? (
                      <p className="text-xs text-muted-foreground py-1">No decisions yet — they appear after a clearance analysis.</p>
                    ) : (
                      <div className="space-y-3">
                        {[
                          { key: "GO", label: "Proceed", color: "hsl(var(--success))", icon: CheckCircle },
                          { key: "DELAY", label: "Delayed", color: "hsl(var(--caution))", icon: Clock },
                          { key: "REROUTE", label: "Rerouted", color: "hsl(var(--signal))", icon: Navigation },
                        ].map(({ key, label, color, icon: Icon }) => {
                          const count = decisions.find((x) => x.decision === key)?.count ?? 0;
                          const pct = (count / totalDecisions) * 100;
                          return (
                            <div key={key} className="flex items-center gap-3">
                              <Icon className="w-4 h-4 shrink-0" style={{ color }} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs text-foreground/75">{label}</span>
                                  <span className="text-xs font-mono font-semibold tabular" style={{ color }}>{count} · {Math.round(pct)}%</span>
                                </div>
                                <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                                  <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.9, ease: "easeOut" }}
                                    className="h-full rounded-full" style={{ background: color }} />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Network — real counts only */}
                  <section className="panel rounded-xl p-4" aria-labelledby="net-h">
                    <div className="flex items-center justify-between mb-3">
                      <h3 id="net-h" className="text-sm font-semibold">Network</h3>
                      <Radio className="w-3.5 h-3.5 text-muted-foreground" />
                    </div>
                    <dl className="grid grid-cols-3 gap-2">
                      {[
                        { label: "Vertiports", value: vertiports.length },
                        { label: "Mapped", value: mapped.length },
                        { label: "Archived", value: historical.length },
                      ].map(({ label, value }) => (
                        <div key={label} className="well rounded-lg px-3 py-2.5">
                          <dt className="label-caps">{label}</dt>
                          <dd className="text-lg font-display font-semibold tabular mt-0.5">{loadingFlights ? "—" : value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>

                  {/* Recent flights */}
                  <section aria-labelledby="recent-h">
                    <div className="flex items-center justify-between mb-2.5">
                      <h3 id="recent-h" className="text-sm font-semibold">Recent flights</h3>
                      <button onClick={() => setTab("flights")} className="text-xs text-primary hover:underline flex items-center gap-0.5">
                        View all <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {loadingFlights ? <Spinner /> : flights.length === 0 ? (
                      <EmptyFlights onPlan={() => navigate("/plan")} />
                    ) : (
                      <ul className="space-y-2">
                        {flights.slice(0, 5).map((f) => {
                          const cfg = statusOf(f.status);
                          return (
                            <li key={f.id}>
                              <button
                                onClick={() => { setTab("flights"); selectFlight(f.id); }}
                                className="w-full panel rounded-xl px-3.5 py-3 flex items-center gap-3 hover:border-primary/30 transition-colors text-left"
                              >
                                <ScoreRing score={f.trajectory_score ?? 0} size={38} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 text-[13px]">
                                    <span className="font-medium truncate">{placeName(f.origin)}</span>
                                    <ArrowRight className="w-3 h-3 text-primary shrink-0" />
                                    <span className="truncate text-foreground/70">{placeName(f.destination)}</span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-1">
                                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                    <span className={`text-[11px] font-mono ${cfg.color}`}>{cfg.label}</span>
                                    <span className="text-[11px] font-mono text-muted-foreground">{f.aircraft_id}</span>
                                    {f.conflicts > 0 && (
                                      <span className="text-[11px] font-mono text-destructive flex items-center gap-0.5">
                                        <AlertCircle className="w-3 h-3" />{f.conflicts}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              </aside>
            </motion.div>
          )}

          {/* ═══ FLIGHTS ═══ */}
          {tab === "flights" && (
            <motion.div
              key="flights"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 flex flex-col md:block overflow-y-auto md:overflow-hidden"
            >
              <div className="relative shrink-0 h-[44vh] min-h-[280px] md:absolute md:inset-0 md:h-auto">
                <OpsMap routes={mapRoutes} frame={frame} />
                {mapOverlay}
              </div>

              {/* Flight list — floating on md+, stacked on mobile */}
              <div className="md:absolute md:left-3 md:top-16 md:bottom-14 md:w-80 flex flex-col md:pointer-events-none">
                <div className="md:glass-panel md:rounded-2xl flex flex-col overflow-hidden md:pointer-events-auto md:max-h-full border-t md:border-t-0 border-border">
                  <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
                    <h3 className="text-sm font-semibold">Open flight plans</h3>
                    <span className="label-caps tabular">{flights.length}</span>
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {loadingFlights ? <Spinner /> : flights.length === 0 ? (
                      <div className="p-4"><EmptyFlights onPlan={() => navigate("/plan")} /></div>
                    ) : (
                      <ul className="divide-y divide-border">
                        {flights.map((f) => {
                          const cfg = statusOf(f.status);
                          const sel = selectedId === f.id;
                          return (
                            <li key={f.id}>
                              <button
                                onClick={() => selectFlight(sel ? null : f.id)}
                                aria-pressed={sel}
                                className={`w-full px-4 py-3 text-left transition-colors flex items-center gap-3 ${sel ? "bg-primary/10" : "hover:bg-white/5"}`}
                              >
                                <ScoreRing score={f.trajectory_score ?? 0} size={36} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-[13px] font-medium truncate">{placeName(f.origin)} → {placeName(f.destination)}</p>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                    <span className={`text-[11px] font-mono ${cfg.color}`}>{cfg.label}</span>
                                    {!mappedIds.has(f.id) && <span className="text-[10px] font-mono text-muted-foreground">no coords</span>}
                                  </div>
                                </div>
                                {sel && <ChevronRight className="w-4 h-4 text-primary shrink-0" />}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  <div className="shrink-0 p-3 border-t border-border">
                    <button onClick={() => navigate("/plan")}
                      className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg h-10 text-xs font-semibold hover:brightness-110 transition"
                    >
                      <Plus className="w-4 h-4" /> New flight plan
                    </button>
                  </div>
                </div>
              </div>

              {/* Detail panel */}
              <AnimatePresence>
                {selectedFlight && (
                  <motion.aside
                    key={selectedFlight.id}
                    initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }}
                    transition={{ duration: 0.2 }}
                    className="md:absolute md:right-3 md:top-16 md:w-80 glass-panel md:rounded-2xl p-4 space-y-4 border-t md:border-t border-border"
                    aria-label="Flight details"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="label-caps mb-1">Flight details</p>
                        <p className="text-sm font-semibold truncate">{placeName(selectedFlight.origin)}</p>
                        <p className="text-sm text-foreground/70 truncate flex items-center gap-1">
                          <ArrowRight className="w-3 h-3 text-primary shrink-0" />{placeName(selectedFlight.destination)}
                        </p>
                      </div>
                      <ScoreRing score={selectedFlight.trajectory_score ?? 0} size={48} />
                    </div>
                    <dl className="grid grid-cols-2 gap-2">
                      {[
                        { label: "Aircraft", value: selectedFlight.aircraft_id || "—" },
                        { label: "Status", value: statusOf(selectedFlight.status).label },
                        { label: "Weather", value: selectedFlight.weather_risk || "—" },
                        { label: "Conflicts", value: String(selectedFlight.conflicts) },
                      ].map(({ label, value }) => (
                        <div key={label} className="well rounded-lg px-3 py-2">
                          <dt className="label-caps">{label}</dt>
                          <dd className="text-xs font-medium mt-1 truncate capitalize">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    {!mappedIds.has(selectedFlight.id) && (
                      <p className="text-[11px] text-caution flex items-center gap-1.5">
                        <MapPin className="w-3 h-3" /> No coordinates on file — not shown on the map.
                      </p>
                    )}
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-mono text-muted-foreground">
                        Filed {new Date(selectedFlight.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </p>
                      <button onClick={() => setSelectedId(null)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                        <X className="w-3.5 h-3.5" /> Close
                      </button>
                    </div>
                  </motion.aside>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {/* ═══ HISTORY ═══ */}
          {tab === "history" && (
            <motion.div
              key="history"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 overflow-y-auto"
            >
              <div className="max-w-5xl mx-auto px-4 py-6">
                <div className="flex items-end justify-between mb-4">
                  <div>
                    <h2 className="text-xl font-semibold">Flight history</h2>
                    <p className="text-xs text-muted-foreground mt-1">{historical.length} archived flight{historical.length === 1 ? "" : "s"}</p>
                  </div>
                </div>

                {loadingFlights ? <Spinner /> : historical.length === 0 ? (
                  <div className="panel rounded-2xl p-12 text-center">
                    <Plane className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                    <p className="text-sm font-medium">No completed flights yet</p>
                    <p className="text-xs text-muted-foreground mt-1">Landed flights appear here for analytics.</p>
                  </div>
                ) : (
                  <div className="panel rounded-2xl overflow-hidden" role="table" aria-label="Archived flights">
                    <div role="row" className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_1fr_70px_90px_130px] gap-4 px-5 py-2.5 border-b border-border bg-white/[0.02]">
                      {["", "Route", "Score", "Weather", "Landed"].map((h, i) => (
                        <span key={i} role="columnheader" className={`label-caps ${i === 2 || i === 3 ? "hidden md:block" : ""}`}>{h}</span>
                      ))}
                    </div>
                    <div className="divide-y divide-border">
                      {historical.map((h, i) => (
                        <motion.div
                          role="row"
                          key={h.id}
                          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                          transition={{ delay: Math.min(i, 15) * 0.025 }}
                          className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_1fr_70px_90px_130px] gap-4 items-center px-5 py-3.5 hover:bg-white/[0.03] transition-colors"
                        >
                          <ScoreRing score={h.trajectory_score ?? 0} size={36} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-[13px]">
                              <span className="font-medium truncate">{placeName(h.origin)}</span>
                              <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                              <span className="truncate text-foreground/65">{placeName(h.destination)}</span>
                            </div>
                            <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{h.aircraft_id || "—"}</p>
                          </div>
                          <span className="hidden md:block text-xs font-mono tabular text-foreground/75">{h.trajectory_score ?? "—"}</span>
                          <span className="hidden md:block text-xs font-mono text-muted-foreground capitalize">{h.weather_risk ?? "n/a"}</span>
                          <span className="text-[11px] font-mono text-muted-foreground tabular text-right md:text-left">
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

function EmptyFlights({ onPlan }: { onPlan: () => void }) {
  return (
    <div className="panel rounded-xl p-6 text-center">
      <Plane className="w-6 h-6 text-muted-foreground/50 mx-auto mb-2" />
      <p className="text-sm font-medium">No open flight plans</p>
      <p className="text-xs text-muted-foreground mt-1">File a flight to see it here and on the map.</p>
      <button onClick={onPlan} className="mt-3 text-xs text-primary hover:underline font-medium">
        Plan your first flight →
      </button>
    </div>
  );
}
