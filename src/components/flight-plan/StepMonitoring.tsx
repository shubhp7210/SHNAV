import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle, AlertTriangle, Radio, Navigation, Zap, Activity,
  Home, LayoutDashboard, ArrowRight,
} from "lucide-react";
import { motion } from "framer-motion";
import type { FlightPlanData } from "@/pages/FlightPlan";
import type { TrajectoryPredictorResult, FutureConflict } from "@/lib/atmTypes";
import { FlightAudio, haptic } from "@/lib/flightAudio";
import { supabase } from "@/integrations/supabase/client";
import HudOverlay, { type PovMode } from "@/components/flight-plan/HudOverlay";
import MapView, { type Pt } from "@/components/MapView";
import Cockpit from "@/components/flight-plan/Cockpit";
import type { CameraMode } from "@/lib/cesium/cameraModes";

// ── Constants ─────────────────────────────────────────────────────────────────
const POV_COOLDOWN_MS = 4000;
const SHARP_TURN_DEG  = 35;

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
}

// ── Coord helpers ─────────────────────────────────────────────────────────────
const CITY_COORDS: Record<string, [number, number]> = {
  "new york": [-73.985, 40.748], "nyc": [-73.985, 40.748],
  "manhattan": [-73.97, 40.776], "brooklyn": [-73.944, 40.678],
  "jfk": [-73.779, 40.641],     "laguardia": [-73.872, 40.776],
  "newark": [-74.175, 40.69],   "hoboken": [-74.031, 40.744],
  "jersey city": [-74.047, 40.718],
  "los angeles": [-118.243, 34.052], "chicago": [-87.623, 41.883],
  "miami": [-80.191, 25.761],   "seattle": [-122.332, 47.606],
  "boston": [-71.057, 42.361],  "san francisco": [-122.419, 37.774],
};

function getCoords(loc: string, fb: [number, number]): [number, number] {
  if (!loc) return fb;
  const tagged = loc.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (tagged) return [parseFloat(tagged[2]), parseFloat(tagged[1])];
  const bare = loc.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (bare) return [parseFloat(bare[2]), parseFloat(bare[1])];
  const key = loc.toLowerCase().trim();
  for (const [k, v] of Object.entries(CITY_COORDS)) {
    if (key.includes(k)) return v;
  }
  return fb;
}

// ── Route helpers ─────────────────────────────────────────────────────────────
function buildRoute(a: [number, number], b: [number, number], n = 160): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const arc = Math.sin(t * Math.PI) * 0.014;
    pts.push([a[0] + (b[0] - a[0]) * t + arc * 0.3, a[1] + (b[1] - a[1]) * t + arc]);
  }
  return pts;
}

function getPlannedRoute(data: FlightPlanData): [number, number][] | null {
  const decisionRouteId = data.atmEngines.flightDecision?.route_id;
  const matched = decisionRouteId
    ? data.routeData?.alternate_routes.find((r) => r.id === decisionRouteId)
    : null;
  const route = matched ?? data.routeData?.primary_route;
  if (!route?.waypoints?.length) return null;
  const pts = route.waypoints
    .filter((p) => typeof p?.lon === "number" && typeof p?.lat === "number")
    .map((p) => [p.lon, p.lat] as [number, number]);
  return pts.length >= 2 ? pts : null;
}

/** Total great-circle length of a {lat,lng} polyline, in km. */
function routeLengthKm(pts: Pt[]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (pts[i].lat - pts[i - 1].lat) * r;
    const dLng = (pts[i].lng - pts[i - 1].lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(pts[i - 1].lat * r) * Math.cos(pts[i].lat * r) * Math.sin(dLng / 2) ** 2;
    km += 2 * R * Math.asin(Math.sqrt(h));
  }
  return km;
}

function calcBearing(a: [number, number], b: [number, number]): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dl = r(b[0] - a[0]);
  const y  = Math.sin(dl) * Math.cos(r(b[1]));
  const x  = Math.cos(r(a[1])) * Math.sin(r(b[1])) - Math.sin(r(a[1])) * Math.cos(r(b[1])) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// (Vehicle, pins and route are drawn by the renderer inside <MapView/>.)

// ── Main component ────────────────────────────────────────────────────────────
const StepMonitoring = ({ data, updateData }: Props) => {
  const navigate = useNavigate();

  // Animation / telemetry refs
  const animRef      = useRef<number | null>(null);
  const startTsRef   = useRef<number | null>(null);

  // Audio / haptic refs
  const audioRef      = useRef<FlightAudio | null>(null);
  const lastStatusRef = useRef<"nominal" | "alert">("nominal");
  const waypointsHit  = useRef(new Set<number>());

  // UI state
  const [progress,   setProgress]   = useState(0);
  const [completed,  setCompleted]  = useState(false);
  const [status,     setStatus]     = useState<"nominal" | "alert">("nominal");
  const [muted,      setMuted]      = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>("follow");
  const [nowTick,    setNowTick]    = useState(() => Date.now());
  const lastTsRef = useRef<number>(Date.now());
  const [liveConflicts,  setLiveConflicts]  = useState<FutureConflict[]>([]);
  const [flowEfficiency, setFlowEfficiency] = useState(100);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // HUD state
  const [heading,    setHeading]    = useState(0);
  const [speedKmh,   setSpeedKmh]   = useState(0);
  const [povMode,    setPovMode]    = useState<PovMode>("hyb");
  const [autoPov,    setAutoPov]    = useState(true);
  const [driftClock, setDriftClock] = useState<number | null>(null);

  const povRef           = useRef<PovMode>("hyb");
  const lastPovChangeRef = useRef(0);
  const lastHeadingRef   = useRef(0);
  const lastHeadingTsRef = useRef(0);
  const tacTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  const windSpeed = data.atmEngines?.weatherIntel?.origin_weather?.wind_speed ?? null;

  // Planned route as {lat,lng} for the no-WebGL Map3D fallback.
  const mon3d = useMemo<Pt[]>(() => {
    const o = getCoords(data.origin, [-73.985, 40.748]);
    const d = getCoords(data.destination, [-73.94, 40.795]);
    const pts = getPlannedRoute(data) ?? buildRoute(o, d);
    return pts.map(([lng, lat]) => ({ lat, lng }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.origin, data.destination, data.routeData, data.atmEngines.flightDecision?.route_id]);

  const changePov = (next: PovMode, manual = false) => {
    const now = performance.now();
    if (!manual && now - lastPovChangeRef.current < POV_COOLDOWN_MS) return;
    if (povRef.current === next) return;
    povRef.current = next;
    lastPovChangeRef.current = now;
    setPovMode(next);
  };

  const computeDriftClock = (pos: [number, number], nearPt: [number, number], hdg: number): number => {
    const brg = calcBearing(pos, nearPt);
    const rel = (brg - hdg + 360) % 360;
    const slot = Math.round(rel / 30);
    const clk  = ((slot + 11) % 12) + 1;
    return clk === 0 ? 12 : clk;
  };

  const evaluateAutoPov = (newHdg: number, ts: number) => {
    if (!autoPov) return;
    const dt = ts - lastHeadingTsRef.current;
    if (lastHeadingTsRef.current === 0) { lastHeadingRef.current = newHdg; lastHeadingTsRef.current = ts; return; }
    if (dt < 1500) return;
    const delta = Math.abs(((newHdg - lastHeadingRef.current + 540) % 360) - 180);
    lastHeadingRef.current    = newHdg;
    lastHeadingTsRef.current  = ts;
    if (delta >= SHARP_TURN_DEG && povRef.current !== "tac") {
      const prev = povRef.current;
      changePov("tac");
      if (tacTimerRef.current) clearTimeout(tacTimerRef.current);
      tacTimerRef.current = setTimeout(() => changePov(prev), 6000);
    }
  };

  // Drive the cockpit's freshness / "stale" indicator once per second.
  useEffect(() => {
    if (!data.monitoringActive) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [data.monitoringActive]);

  // ── Trajectory polling ────────────────────────────────────────────────────
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

  // ── Telemetry driver: real GPS → simulation fallback ──────────────────────
  // Renderer-agnostic: drives progress/heading/speed/status; <MapView/> renders
  // the vehicle from `progress`. Landing + record-outcome effects key off
  // `progress`, so the learning loop fires regardless of which renderer is active.
  useEffect(() => {
    if (!data.monitoringActive) return;
    const pts: [number, number][] = mon3d.map((p) => [p.lng, p.lat]); // [lng,lat]
    if (pts.length < 2) return;

    audioRef.current?.startAmbient();
    haptic([40, 20, 80, 20, 120]);

    const distM = (a: [number, number], b: [number, number]) => {
      const R = 6_371_000, r = Math.PI / 180;
      const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
      const h = Math.sin(dLat/2)**2 + Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    const nearestIdx = (pos: [number, number]) => {
      let best = { idx: 0, m: Infinity };
      pts.forEach((p, i) => { const m = distM(pos, p); if (m < best.m) best = { idx: i, m }; });
      return best;
    };
    const handleAlert = (newStatus: "nominal" | "alert") => {
      if (newStatus === lastStatusRef.current) return;
      lastStatusRef.current = newStatus;
      setStatus(newStatus);
      if (newStatus === "alert") { audioRef.current?.playAlert();      haptic([150, 80, 150, 80, 200]); }
      else                       { audioRef.current?.playAlertClear(); haptic([60]); }
    };

    const onGps = (geo: GeolocationPosition) => {
      const pos: [number, number] = [geo.coords.longitude, geo.coords.latitude];
      const { idx, m } = nearestIdx(pos);
      setProgress(idx / Math.max(1, pts.length - 1));
      handleAlert(m > 250 ? "alert" : "nominal");
      const hdg = geo.coords.heading ?? calcBearing(pos, pts[Math.min(idx + 3, pts.length - 1)]);
      setHeading(hdg);
      setSpeedKmh((geo.coords.speed ?? 0) * 3.6);
      setDriftClock(m > 250 ? computeDriftClock(pos, pts[idx], hdg) : null);
      evaluateAutoPov(hdg, performance.now());
      lastTsRef.current = Date.now();
    };

    const startSim = () => {
      const DURATION = 48_000;
      startTsRef.current = null;
      const tick = (ts: number) => {
        if (!startTsRef.current) startTsRef.current = ts;
        const t   = Math.min((ts - startTsRef.current) / DURATION, 1);
        const idx = Math.min(Math.floor(t * (pts.length - 1)), pts.length - 2);
        const pos = pts[idx];
        const hdg = calcBearing(pos, pts[Math.min(idx + 6, pts.length - 1)]);
        setProgress(t);
        handleAlert(t >= 0.28 && t < 0.42 ? "alert" : "nominal");
        for (const mark of [25, 50, 75]) {
          const pct = Math.round(t * 100);
          if (pct >= mark && !waypointsHit.current.has(mark)) {
            waypointsHit.current.add(mark);
            audioRef.current?.playWaypoint();
            haptic([30]);
          }
        }
        if (t >= 1 && !waypointsHit.current.has(100)) {
          waypointsHit.current.add(100);
          audioRef.current?.playArrival();
          audioRef.current?.stopAmbient(3);
          haptic([80, 40, 80, 40, 300]);
        }
        setHeading(hdg);
        setSpeedKmh(90);
        setDriftClock(t >= 0.28 && t < 0.42 ? computeDriftClock(pos, pts[idx], hdg) : null);
        evaluateAutoPov(hdg, ts);
        lastTsRef.current = Date.now();
        if (t < 1) animRef.current = requestAnimationFrame(tick);
      };
      animRef.current = requestAnimationFrame(tick);
    };

    let watchId: number | null = null;
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (geo) => {
          onGps(geo);
          watchId = navigator.geolocation.watchPosition(onGps, () => {
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            if (!animRef.current) startSim();
          }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10_000 });
        },
        () => startSim(),
        { enableHighAccuracy: true, timeout: 8_000 },
      );
    } else {
      startSim();
    }

    return () => {
      if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null; }
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      startTsRef.current = null;
      waypointsHit.current.clear();
      lastStatusRef.current = "nominal";
    };
  }, [data.monitoringActive, mon3d, data.aircraftId, data.flightIntentId]);

  // ── Flight lifecycle ──────────────────────────────────────────────────────
  // Supabase query builders are lazy — they only execute when awaited, so
  // these updates must live inside an async call, not as bare statements.
  useEffect(() => {
    if (!data.monitoringActive || !data.flightIntentId) return;
    void (async () => {
      const { error } = await supabase
        .from("flight_intents")
        .update({ status: "in_air" })
        .eq("id", data.flightIntentId!);
      if (error) console.warn("[flight] in_air update failed", error.message);
    })();
  }, [data.monitoringActive, data.flightIntentId]);

  const landedRef = useRef(false);
  useEffect(() => {
    if (landedRef.current || progress < 1 || !data.flightIntentId) return;
    landedRef.current = true;
    const intentId = data.flightIntentId;
    const landedAt = new Date().toISOString();
    void (async () => {
      // record-flight-outcome marks the flight landed server-side and feeds
      // the learning loop (patterns, weights, user error profile).
      const decision = data.atmEngines.flightDecision;
      const plannedMin = data.routeData?.primary_route?.estimated_time_min ?? null;
      const { error } = await supabase.functions.invoke("record-flight-outcome", {
        body: {
          flight_intent_id: intentId,
          aircraft_id: data.aircraftId || "UNKNOWN",
          route_id: data.routeData?.route_id ?? null,
          decision_id: decision?.decision_id ?? null,
          planned_departure_time: decision?.departure_time ?? null,
          actual_arrival_time: landedAt,
          planned_duration_minutes: plannedMin,
          actual_duration_minutes: plannedMin ?? 0,
          delay_minutes: decision?.delay_minutes ?? 0,
          predicted_overall_score: data.routeData?.primary_route?.overall_score ?? null,
          predicted_weather_risk: data.weatherRisk || null,
          completion_status: "completed",
        },
      });
      if (error) {
        console.warn("[flight] record-flight-outcome failed, marking landed directly", error.message);
        const { error: updateErr } = await supabase
          .from("flight_intents")
          .update({ status: "landed", landed_at: landedAt })
          .eq("id", intentId);
        if (updateErr) console.warn("[flight] landed update failed", updateErr.message);
      }
    })();
  }, [progress, data.flightIntentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (progress < 1) return;
    const t = setTimeout(() => setCompleted(true), 1500);
    return () => clearTimeout(t);
  }, [progress]);

  // Tear down the Web Audio context on unmount — it is otherwise leaked.
  useEffect(() => () => {
    audioRef.current?.destroy();
    audioRef.current = null;
  }, []);

  // ── Completion screen ─────────────────────────────────────────────────────
  if (completed) {
    const score = data.trajectoryScore ?? 0;
    const scoreColor = score >= 80 ? "#34d399" : score >= 60 ? "#fbbf24" : "#f87171";
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}
        className="flex flex-col items-center text-center py-6 gap-6"
      >
        <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
          className="relative flex items-center justify-center"
        >
          <div className="absolute inset-0 rounded-full bg-emerald-400/10 animate-ping" style={{ width: 88, height: 88 }} />
          <div className="w-20 h-20 rounded-full bg-emerald-400/10 border-2 border-emerald-400/50 flex items-center justify-center">
            <CheckCircle className="w-9 h-9 text-emerald-400" strokeWidth={1.75} />
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
          <p className="text-[11px] font-mono tracking-[0.25em] uppercase text-emerald-400 mb-1">Mission Complete</p>
          <h3 className="text-2xl font-bold">Flight Landed</h3>
          <p className="text-sm text-muted-foreground mt-1 font-mono">
            {data.origin || "Origin"} <ArrowRight className="inline w-3.5 h-3.5 text-primary" /> {data.destination || "Destination"}
          </p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="grid grid-cols-3 gap-3 w-full max-w-sm"
        >
          {[
            { label: "Aircraft",   value: data.aircraftId || "—" },
            { label: "Traj Score", value: String(score), style: { color: scoreColor } },
            { label: "Status",     value: "Nominal",     style: { color: "#34d399" } },
          ].map(({ label, value, style }) => (
            <div key={label} className="glass-card rounded-xl px-3 py-3.5">
              <p className="text-base font-bold font-mono" style={style ?? {}}>{value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55 }}
          className="flex flex-col sm:flex-row gap-3 w-full max-w-sm"
        >
          <button onClick={() => navigate("/")}
            className="flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
          >
            <Home className="w-4 h-4" /> Back to Home
          </button>
          <button onClick={() => navigate("/dashboard")}
            className="flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-border text-foreground/70 font-medium text-sm hover:bg-secondary/40 transition-colors"
          >
            <LayoutDashboard className="w-4 h-4" /> Dashboard
          </button>
        </motion.div>
      </motion.div>
    );
  }

  // ── Idle screen ───────────────────────────────────────────────────────────
  if (!data.monitoringActive) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground text-sm">Real-time 3D flight monitoring over the planned route.</p>
        <div className="py-14 text-center space-y-5">
          <div className="relative inline-flex items-center justify-center w-16 h-16 mx-auto">
            <div className="absolute inset-0 rounded-full bg-primary/10 animate-ping" />
            <Radio className="relative w-8 h-8 text-primary opacity-70" />
          </div>
          <div>
            <p className="text-foreground font-medium">3D Map — Ready</p>
            <p className="text-muted-foreground text-sm mt-1">Monitoring activates once the simulation begins.</p>
          </div>
          <button
            onClick={() => {
              const audio = new FlightAudio();
              audio.init();
              audio.playTakeoff();
              audioRef.current = audio;
              haptic([60, 30, 120]);
              updateData({ monitoringActive: true });
            }}
            className="px-7 py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:bg-primary/90 transition-colors"
          >
            Launch 3D Simulation
          </button>
        </div>
      </div>
    );
  }

  const pct = Math.round(progress * 100);
  const eta = Math.max(0, Math.round((1 - progress) * 48));
  const remainingKm = mon3d.length >= 2 ? routeLengthKm(mon3d) * (1 - progress) : null;

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className={`flex items-center gap-3 p-3 rounded-lg border transition-colors duration-500 ${
        status === "nominal" ? "border-primary/30 bg-primary/5" : "border-amber-500/50 bg-amber-500/10"
      }`}>
        {status === "nominal"
          ? <CheckCircle className="w-5 h-5 text-primary shrink-0" />
          : <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 animate-pulse" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">
            {status === "nominal" ? "On Track — Nominal" : "Deviation Detected"}
          </p>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {status === "nominal"
              ? "All trajectory constraints within tolerance"
              : "Lateral deviation — evaluating corridor"}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">ETA</p>
          <p className="text-sm font-mono font-bold text-primary">{eta}s</p>
        </div>
      </div>

      {/* Progress */}
      <div className="h-[3px] rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>

      {/* 3D Map */}
      <div className="relative w-full rounded-xl overflow-hidden border border-white/10 h-[60vh] min-h-[360px] md:h-[460px]">
        <MapView
          routes={[mon3d]} progress={progress} heading={heading} speedKmh={speedKmh}
          cameraMode={cameraMode} interactive color="#FF3157" label="Flight route"
        />

        <HudOverlay
          heading={heading} speedKmh={speedKmh} windSpeed={windSpeed}
          povMode={povMode} autoPov={autoPov}
          onPovChange={(m) => {
            if (tacTimerRef.current) { clearTimeout(tacTimerRef.current); tacTimerRef.current = null; }
            changePov(m, true);
            haptic([15]);
          }}
          onToggleAutoPov={() => setAutoPov((v) => !v)}
          driftClock={driftClock}
          driftSeverity={status === "alert" ? "moderate" : "low"}
        />

        <Cockpit
          heading={heading}
          speedKmh={speedKmh}
          progress={progress}
          status={status}
          distanceKm={remainingKm}
          lastUpdateMs={lastTsRef.current}
          now={nowTick}
          cameraMode={cameraMode}
          onMode={(m) => { setCameraMode(m); haptic([15]); }}
          muted={muted}
          onToggleMute={() => { const n = !muted; setMuted(n); audioRef.current?.setMuted(n); haptic([15]); }}
        />
      </div>

      {/* Route info */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "FROM",     value: data.origin      || "—", color: "text-primary" },
          { label: "PROGRESS", value: `${pct}%` },
          { label: "TO",       value: data.destination || "—" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-secondary/50 rounded-lg p-3 text-center border border-border/30">
            <p className={`text-xs font-mono font-bold truncate ${color ?? "text-foreground"}`}>{value}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5 tracking-wider">{label}</p>
          </div>
        ))}
      </div>

      {/* Live trajectory intelligence */}
      <div className="rounded-xl border border-white/10 bg-black/20 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">Live Trajectory</span>
          </div>
          <div className="flex items-center gap-3">
            <Zap className="w-3 h-3 text-primary" />
            <span className="text-[10px] text-white/40">Flow</span>
            <span className={`text-[10px] font-bold ${flowEfficiency >= 80 ? "text-emerald-400" : flowEfficiency >= 60 ? "text-amber-400" : "text-red-400"}`}>
              {flowEfficiency}%
            </span>
            <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${liveConflicts.length > 0 ? "bg-red-400" : "bg-emerald-400"}`} />
          </div>
        </div>
        <div className="p-3">
          {liveConflicts.length === 0 ? (
            <div className="flex items-center gap-2 text-emerald-400 text-xs">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" /> No conflicts in 5-minute horizon
            </div>
          ) : (
            <div className="space-y-2">
              {liveConflicts.slice(0, 3).map((c, i) => (
                <div key={i} className={`flex items-center justify-between p-2 rounded-lg text-xs border ${
                  c.severity === "high"     ? "border-red-500/30 bg-red-500/5 text-red-300" :
                  c.severity === "moderate" ? "border-amber-500/30 bg-amber-500/5 text-amber-300" :
                                              "border-yellow-500/20 bg-yellow-500/5 text-yellow-300"
                }`}>
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
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
