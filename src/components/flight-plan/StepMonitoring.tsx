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
import { reportClientError } from "@/lib/errorReporter";
import HudOverlay, { type PovMode } from "@/components/flight-plan/HudOverlay";
import MapView, { type Pt } from "@/components/MapView";
import { bandHeight } from "@/lib/geo/region";
import { densify, locationCoords, plannedRoute, routeLengthKm } from "@/lib/geo/coords";
import Cockpit from "@/components/flight-plan/Cockpit";
import type { CameraMode } from "@/lib/cesium/cameraModes";

// ── Constants ─────────────────────────────────────────────────────────────────
const POV_COOLDOWN_MS = 4000;
const SHARP_TURN_DEG  = 35;

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
}

// Fallback endpoints (Midtown → Upper East Side) when a location can't be
// resolved — only used to keep the simulation running, never written back.
const FALLBACK_O: Pt = { lat: 40.748, lng: -73.985 };
const FALLBACK_D: Pt = { lat: 40.795, lng: -73.94 };

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
  // Where telemetry comes from — only real GPS flights feed the learning loop.
  const telemetrySourceRef = useRef<"gps" | "sim" | null>(null);
  const takeoffAtRef = useRef<number | null>(null);


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

  // Planned route as {lat,lng}: the decision engine's route, else a straight
  // densified leg between the filed endpoints.
  const mon3d = useMemo<Pt[]>(() => {
    const planned = plannedRoute(data.routeData, data.atmEngines.flightDecision?.route_id);
    if (planned) return planned;
    return densify(locationCoords(data.origin) ?? FALLBACK_O, locationCoords(data.destination) ?? FALLBACK_D);
  }, [data.origin, data.destination, data.routeData, data.atmEngines.flightDecision?.route_id]);
  const corridor = bandHeight(data.altitudeBand);
  const placeName = (loc: string) => (loc ?? "").replace(/\s*@\s*-?\d+\.?\d*\s*,\s*-?\d+\.?\d*\s*$/, "");

  // Stable array identity — progress re-renders this component every frame.
  const monRoutes = useMemo(() => [mon3d], [mon3d]);

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

    takeoffAtRef.current ??= Date.now();
    const onGps = (geo: GeolocationPosition) => {
      telemetrySourceRef.current = "gps";
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
      telemetrySourceRef.current = "sim";
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
    const landedAt = new Date();
    void (async () => {
      const markLanded = async () => {
        const { error } = await supabase.from("flight_intents")
          .update({ status: "landed", landed_at: landedAt.toISOString() }).eq("id", intentId);
        if (error) reportClientError(new Error(`landed update failed: ${error.message}`), "manual", "warning");
      };
      // Only real GPS-tracked flights train the learning loop, with MEASURED
      // times. A simulated run (48 s replay) is archived but never recorded as
      // an outcome — it would teach the model fabricated durations.
      if (telemetrySourceRef.current !== "gps" || takeoffAtRef.current == null) {
        await markLanded();
        return;
      }
      const decision = data.atmEngines.flightDecision;
      const plannedMin = data.routeData?.primary_route?.estimated_time_min ?? null;
      const actualMin = Math.max(0, (landedAt.getTime() - takeoffAtRef.current) / 60_000);
      const { error } = await supabase.functions.invoke("record-flight-outcome", {
        body: {
          flight_intent_id: intentId,
          aircraft_id: data.aircraftId || "UNKNOWN",
          route_id: data.routeData?.route_id ?? undefined,
          decision_id: decision?.decision_id ?? undefined,
          planned_departure_time: decision?.departure_time ?? undefined,
          actual_departure_time: new Date(takeoffAtRef.current).toISOString(),
          actual_arrival_time: landedAt.toISOString(),
          planned_duration_minutes: plannedMin ?? undefined,
          actual_duration_minutes: Math.round(actualMin * 10) / 10,
          delay_minutes: Math.max(0, decision?.departure_time
            ? (takeoffAtRef.current - new Date(decision.departure_time).getTime()) / 60_000 : 0),
          predicted_overall_score: data.routeData?.primary_route?.overall_score ?? undefined,
          predicted_weather_risk: ["low", "moderate", "high", "unknown"].includes(data.weatherRisk) ? data.weatherRisk : undefined,
          completion_status: "completed",
        },
      });
      if (error) {
        reportClientError(new Error(`record-flight-outcome failed: ${error.message}`), "manual", "warning");
        await markLanded();
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
    const scoreColor = score >= 80 ? "hsl(var(--success))" : score >= 60 ? "hsl(var(--caution))" : "hsl(var(--destructive))";
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}
        className="panel rounded-2xl flex flex-col items-center text-center py-12 px-5 gap-6 max-w-2xl mx-auto"
      >
        <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
          className="relative flex items-center justify-center w-20 h-20"
        >
          <span className="absolute inset-0 rounded-full bg-success/10 animate-ping" />
          <span className="relative w-20 h-20 rounded-full bg-success/10 border-2 border-success/50 flex items-center justify-center">
            <CheckCircle className="w-9 h-9 text-success" strokeWidth={1.75} />
          </span>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
          <p className="label-caps text-success mb-2">Mission complete</p>
          <h3 className="text-3xl font-semibold">Flight landed</h3>
          <p className="text-sm text-muted-foreground mt-2 font-mono flex items-center justify-center gap-2 flex-wrap">
            {placeName(data.origin) || "Origin"} <ArrowRight className="inline w-3.5 h-3.5 text-primary" /> {placeName(data.destination) || "Destination"}
          </p>
        </motion.div>
        <motion.dl initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="grid grid-cols-3 gap-3 w-full max-w-md"
        >
          {[
            { label: "Aircraft", value: data.aircraftId || "—" },
            { label: "Traj score", value: String(score), style: { color: scoreColor } },
            { label: "Status", value: "Landed", style: { color: "hsl(var(--success))" } },
          ].map(({ label, value, style }) => (
            <div key={label} className="well rounded-xl px-3 py-3.5">
              <dd className="text-base font-bold font-mono truncate tabular" style={style ?? {}}>{value}</dd>
              <dt className="label-caps mt-1">{label}</dt>
            </div>
          ))}
        </motion.dl>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55 }}
          className="flex flex-col sm:flex-row gap-3 w-full max-w-md"
        >
          <button onClick={() => navigate("/dashboard")}
            className="flex-1 flex items-center justify-center gap-2 px-5 h-11 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:brightness-110 transition"
          >
            <LayoutDashboard className="w-4 h-4" /> Operations
          </button>
          <button onClick={() => navigate("/")}
            className="flex-1 flex items-center justify-center gap-2 px-5 h-11 rounded-xl border border-border text-foreground/80 font-medium text-sm hover:bg-white/5 transition-colors"
          >
            <Home className="w-4 h-4" /> Home
          </button>
        </motion.div>
      </motion.div>
    );
  }

  // ── Idle screen ───────────────────────────────────────────────────────────
  if (!data.monitoringActive) {
    return (
      <div className="panel rounded-2xl grid-pattern overflow-hidden">
        <div className="py-16 px-5 text-center flex flex-col items-center gap-6">
          <div className="relative inline-flex items-center justify-center w-20 h-20">
            <span className="absolute inset-0 rounded-full border border-signal/30 animate-ping" />
            <span className="absolute inset-2 rounded-full border border-signal/40" />
            <Radio className="relative w-8 h-8 text-signal" />
          </div>
          <div>
            <p className="font-display text-xl font-semibold">3D tracking ready</p>
            <p className="text-muted-foreground text-sm mt-1.5 max-w-sm">
              Opens over Manhattan, then follows your aircraft along the cleared route. Live GPS is used when
              available; otherwise the flight is simulated.
            </p>
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
            className="px-7 h-12 bg-primary text-primary-foreground rounded-xl font-semibold text-sm hover:brightness-110 transition shadow-[0_10px_40px_-12px_hsl(var(--primary)/0.7)]"
          >
            Launch 3D tracking
          </button>
        </div>
      </div>
    );
  }

  const pct = Math.round(progress * 100);
  const eta = Math.max(0, Math.round((1 - progress) * 48));
  const remainingKm = mon3d.length >= 2 ? routeLengthKm(mon3d) * (1 - progress) : null;

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
      <div className="space-y-3 min-w-0">
        {/* 3D Map */}
        <div className="relative w-full rounded-2xl overflow-hidden border border-border h-[62vh] min-h-[380px] lg:h-[calc(100dvh-20rem)] lg:min-h-[440px] bg-card">
          <MapView
            routes={monRoutes} progress={progress} heading={heading} speedKmh={speedKmh}
            cameraMode={cameraMode} corridorHeight={corridor}
            endpointLabels={[placeName(data.origin), placeName(data.destination)]}
            interactive label="Flight tracking map"
          />
          <div className="absolute inset-0 pointer-events-none map-vignette" />

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
        {/* Progress */}
        <div className="h-1 rounded-full bg-secondary overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Route progress">
          <div className="h-full rounded-full bg-gradient-to-r from-primary to-caution transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <aside className="space-y-3 min-w-0">
        {/* Status */}
        <div className={`panel rounded-2xl p-4 transition-colors duration-500 ${status === "nominal" ? "" : "border-caution/50 bg-caution/5"}`} aria-live="polite">
          <div className="flex items-start gap-3">
            {status === "nominal"
              ? <CheckCircle className="w-5 h-5 text-success shrink-0 mt-0.5" />
              : <AlertTriangle className="w-5 h-5 text-caution shrink-0 mt-0.5 animate-pulse" />}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">{status === "nominal" ? "On track — nominal" : "Deviation detected"}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {status === "nominal" ? "All trajectory constraints within tolerance" : "Lateral deviation — evaluating corridor"}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="label-caps">ETA</p>
              <p className="text-lg font-mono font-bold text-primary tabular">{eta}s</p>
            </div>
          </div>
        </div>

        {/* Route */}
        <div className="panel rounded-2xl p-4 space-y-3">
          {[
            { label: "From", value: placeName(data.origin) || "—", dot: "bg-primary" },
            { label: "To", value: placeName(data.destination) || "—", dot: "bg-caution" },
          ].map(({ label, value, dot }) => (
            <div key={label} className="flex items-center gap-3 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
              <span className="label-caps w-10 shrink-0">{label}</span>
              <span className="text-sm truncate">{value}</span>
            </div>
          ))}
          <div className="grid grid-cols-3 gap-2 pt-1">
            {[
              { label: "Progress", value: `${pct}%` },
              { label: "Remaining", value: remainingKm != null ? `${remainingKm.toFixed(1)} km` : "—" },
              { label: "Band", value: (data.altitudeBand || "low").toUpperCase() },
            ].map(({ label, value }) => (
              <div key={label} className="well rounded-lg px-2.5 py-2">
                <p className="label-caps">{label}</p>
                <p className="text-sm font-mono font-semibold tabular mt-0.5 truncate">{value}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">Corridor height on the map is a nominal display value for the band.</p>
        </div>

        {/* Live trajectory intelligence */}
        <div className="panel rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-signal" />
              <span className="label-caps text-foreground/75">Live trajectory</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="w-3 h-3 text-signal" />
              <span className="text-[10px] text-muted-foreground">Flow</span>
              <span className={`text-[11px] font-bold tabular ${flowEfficiency >= 80 ? "text-success" : flowEfficiency >= 60 ? "text-caution" : "text-destructive"}`}>
                {flowEfficiency}%
              </span>
              <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${liveConflicts.length > 0 ? "bg-destructive" : "bg-success"}`} />
            </div>
          </div>
          <div className="p-3">
            {liveConflicts.length === 0 ? (
              <p className="flex items-center gap-2 text-success text-xs">
                <span className="w-1.5 h-1.5 bg-success rounded-full" /> No conflicts in 5-minute horizon
              </p>
            ) : (
              <ul className="space-y-2">
                {liveConflicts.slice(0, 3).map((c, i) => (
                  <li key={i} className={`p-2.5 rounded-lg text-xs border ${
                    c.severity === "high" ? "border-destructive/40 bg-destructive/5 text-red-300" :
                    c.severity === "moderate" ? "border-caution/40 bg-caution/5 text-amber-200" :
                    "border-yellow-500/20 bg-yellow-500/5 text-yellow-200"
                  }`}>
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span className="truncate">{c.aircraft_a} ↔ {c.aircraft_b}</span>
                      <span className="text-muted-foreground ml-auto shrink-0">T+{c.t_plus_min}m</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground mt-1">
                      <Navigation className="w-3 h-3 shrink-0" />
                      <span className="text-[11px] truncate">{c.resolution.action}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};

export default StepMonitoring;
