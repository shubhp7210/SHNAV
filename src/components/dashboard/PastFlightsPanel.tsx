import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Database, Flag, Plane, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SourceBadges } from "@/components/atm/ExternalAirspacePanel";

// Rows from the PAST flights store (separate from active flights). Read-only
// for users; values are server-measured (GPS telemetry + METAR observations).
export interface PastFlight {
  id: string; aircraft_id: string; origin: string; destination: string; altitude_band: string | null;
  final_status: string; verification_status: string; verification_notes: string[];
  telemetry_source: string; telemetry_points: number;
  planned_departure_start: string | null; actual_departure_at: string | null; actual_arrival_at: string | null;
  actual_duration_min: number | null; planned_duration_min: number | null; max_deviation_m: number | null;
  weather_obs_status: string; weather_observed: { departure?: { station: string; wind_kmh: number; gust_kmh: number; raw: string } } | null;
  prediction_snapshot: { weather_risk?: string; overall_score?: number; decision?: string; forecast?: { wind_speed?: number; wind_gusts?: number } } | null;
  learning_excluded: boolean; learning_exclusion_reason: string | null; archived_at: string;
}
interface PredictionError { past_flight_id: string; kind: string; predicted: unknown; observed: unknown; error: number | null; verified: boolean; detail: string | null }
interface PatternFlag { id: string; pattern: string; status: string; summary: string; evidence: { rule?: string }; sample_size: number; detected_at: string }
interface SourceRow { id: string; name: string; kind: string; freshness: string; last_success_at: string | null; last_data_at: string | null; licence: string | null }

const placeName = (loc: string) => (loc ?? "").replace(/\s*@\s*-?\d+\.?\d*\s*,\s*-?\d+\.?\d*\s*$/, "") || "—";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

const VERIF: Record<string, { label: string; cls: string; hint: string }> = {
  verified:          { label: "Verified",   cls: "text-success border-success/30 bg-success/10", hint: "GPS-tracked, arrived at the filed destination — eligible for learning" },
  unverified:        { label: "Unverified", cls: "text-caution border-caution/30 bg-caution/10", hint: "Kept for review; never used for learning" },
  simulated:         { label: "Simulated",  cls: "text-signal border-signal/30 bg-signal/10",    hint: "No GPS telemetry — a simulated run; never used for learning" },
  legacy_unverified: { label: "Legacy",     cls: "text-muted-foreground border-border bg-white/[0.03]", hint: "Recorded before server telemetry existed; preserved, never used for learning" },
  rejected:          { label: "Rejected",   cls: "text-destructive border-destructive/30 bg-destructive/10", hint: "Failed integrity checks" },
};

export default function PastFlightsPanel({ userId }: { userId: string | undefined }) {
  const [flights, setFlights] = useState<PastFlight[]>([]);
  const [errors, setErrors] = useState<Record<string, PredictionError[]>>({});
  const [flags, setFlags] = useState<PatternFlag[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [pf, pe, fl, ds] = await Promise.all([
      supabase.from("past_flights").select("*").order("archived_at", { ascending: false }).limit(50),
      supabase.from("prediction_errors").select("past_flight_id, kind, predicted, observed, error, verified, detail").limit(500),
      supabase.from("user_pattern_flags").select("id, pattern, status, summary, evidence, sample_size, detected_at")
        .in("status", ["suspected", "confirmed"]).order("detected_at", { ascending: false }),
      supabase.from("data_source_status").select("id, name, kind, freshness, last_success_at, last_data_at, licence").order("id"),
    ]);
    if (pf.error) setLoadError("Past flights could not be loaded."); else setFlights((pf.data ?? []) as unknown as PastFlight[]);
    const byFlight: Record<string, PredictionError[]> = {};
    for (const e of (pe.data ?? []) as PredictionError[]) (byFlight[e.past_flight_id] ??= []).push(e);
    setErrors(byFlight);
    setFlags((fl.data ?? []) as unknown as PatternFlag[]);
    setSources((ds.data ?? []) as SourceRow[]);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load, userId]);

  const respond = async (flag: PatternFlag, response: "confirm" | "dismiss") => {
    setBusy(flag.id);
    const { error } = await supabase.rpc("respond_pattern_flag", { p_flag: flag.id, p_response: response });
    setBusy(null);
    if (!error) void load();
  };

  const verified = flights.filter((f) => f.verification_status === "verified").length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Past flights</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {flights.length} ended flight{flights.length === 1 ? "" : "s"} · {verified} GPS-verified.
            Past flights are kept separately from active flights and never feed a new flight's calculations directly.
          </p>
        </div>
      </div>

      {/* Suspected input-error patterns — explained, never assumed */}
      {flags.length > 0 && (
        <section className="panel rounded-xl p-4 space-y-3" aria-labelledby="flags-h">
          <h3 id="flags-h" className="text-sm font-semibold flex items-center gap-2"><Flag className="w-4 h-4 text-caution" /> Patterns in your flight data</h3>
          {flags.map((f) => (
            <div key={f.id} className="well rounded-lg p-3">
              <p className="text-[13px]">{f.summary}</p>
              <p className="text-[11px] text-muted-foreground mt-1">Rule: {f.evidence?.rule ?? "—"} · based on {f.sample_size} flights</p>
              {f.status === "suspected" ? (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[11px] text-muted-foreground mr-auto">Not applied to anything until you confirm it.</span>
                  <button disabled={busy === f.id} onClick={() => respond(f, "dismiss")}
                    className="text-xs px-3 py-1 rounded-full border border-border hover:bg-white/5">Not accurate</button>
                  <button disabled={busy === f.id} onClick={() => respond(f, "confirm")}
                    className="text-xs px-3 py-1 rounded-full bg-primary text-primary-foreground hover:opacity-90">Yes, that's right</button>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 text-[11px] text-success">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Confirmed — shown as guidance when you file and in departure decisions.
                  <button disabled={busy === f.id} onClick={() => respond(f, "dismiss")} className="ml-auto text-muted-foreground hover:text-foreground underline">withdraw</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : flights.length === 0 ? (
        <div className="panel rounded-2xl p-12 text-center">
          <Plane className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium">No past flights yet</p>
          <p className="text-xs text-muted-foreground mt-1">A flight moves here once its end is confirmed (landing + GPS, or timeout).</p>
        </div>
      ) : (
        <div className="panel rounded-2xl overflow-hidden divide-y divide-border">
          {flights.map((f) => {
            const v = VERIF[f.verification_status] ?? VERIF.unverified;
            const errs = errors[f.id] ?? [];
            const isOpen = open === f.id;
            return (
              <div key={f.id}>
                <button onClick={() => setOpen(isOpen ? null : f.id)}
                  className="w-full grid grid-cols-[1fr_auto] md:grid-cols-[1fr_110px_120px_150px_20px] gap-3 items-center px-5 py-3.5 text-left hover:bg-white/[0.03]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[13px]">
                      <span className="font-medium truncate">{placeName(f.origin)}</span>
                      <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="truncate text-foreground/65">{placeName(f.destination)}</span>
                    </div>
                    <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{f.aircraft_id} · {f.final_status.replace(/_/g, " ")}</p>
                  </div>
                  <span title={v.hint} className={`text-[10px] font-mono px-2 py-0.5 rounded-full border w-fit ${v.cls}`}>{v.label}</span>
                  <span className="hidden md:block text-xs font-mono text-muted-foreground tabular">
                    {f.actual_duration_min != null ? `${Math.round(f.actual_duration_min * 10) / 10} min` : "—"}
                    {f.planned_duration_min != null && <span className="opacity-60"> / {f.planned_duration_min} plan</span>}
                  </span>
                  <span className="hidden md:block text-[11px] font-mono text-muted-foreground tabular">{when(f.actual_arrival_at ?? f.archived_at)}</span>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground hidden md:block" /> : <ChevronDown className="w-4 h-4 text-muted-foreground hidden md:block" />}
                </button>
                {isOpen && (
                  <div className="px-5 pb-4 grid md:grid-cols-2 gap-3 text-xs">
                    <div className="well rounded-lg p-3 space-y-1">
                      <p className="label-caps mb-1">Record</p>
                      <p>Telemetry: {f.telemetry_source === "gps" ? `${f.telemetry_points} GPS fixes` : "none"}</p>
                      <p>Departed {when(f.actual_departure_at)} · arrived {when(f.actual_arrival_at)}</p>
                      {f.max_deviation_m != null && <p>Max deviation from planned route: {Math.round(f.max_deviation_m)} m</p>}
                      {f.verification_notes?.map((n) => <p key={n} className="text-muted-foreground">• {n}</p>)}
                      {f.learning_excluded && <p className="text-caution">Excluded from learning: {f.learning_exclusion_reason}</p>}
                    </div>
                    <div className="well rounded-lg p-3 space-y-1">
                      <p className="label-caps mb-1">Predicted vs observed</p>
                      {errs.length === 0 ? (
                        <p className="text-muted-foreground">{f.weather_obs_status === "pending" ? "Awaiting observed weather (reconciled within a few hours)." : "No comparable measurements."}</p>
                      ) : errs.map((e) => (
                        <p key={e.kind} className="flex items-center gap-1.5">
                          {e.verified ? <ShieldCheck className="w-3 h-3 text-success" /> : <AlertTriangle className="w-3 h-3 text-caution" />}
                          <span className="font-mono">{e.kind}</span>: predicted {String(e.predicted)} · observed {String(e.observed)}
                          {e.error != null && <span className="text-muted-foreground"> (Δ {Math.round(Number(e.error) * 10) / 10})</span>}
                        </p>
                      ))}
                      {f.weather_observed?.departure && (
                        <p className="text-muted-foreground font-mono break-all mt-1">{f.weather_observed.departure.raw}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Data sources */}
      <section className="panel rounded-xl p-4" aria-labelledby="src-h">
        <h3 id="src-h" className="text-sm font-semibold flex items-center gap-2 mb-2"><Database className="w-4 h-4 text-muted-foreground" /> Data sources</h3>
        {sources.length === 0 ? <p className="text-xs text-muted-foreground">Source status unavailable.</p> : (
          <>
            <SourceBadges sources={sources} />
            <p className="text-[11px] text-muted-foreground mt-2">
              Real observations from aviationweather.gov, NWS, FAA TFRs and OpenSky ADS-B, cross-checked against Open-Meteo forecasts.
              Research &amp; simulation use — not a certified flight-safety system.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
