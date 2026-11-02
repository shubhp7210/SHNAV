// Departure decision logic (pure, unit-tested). Inputs are assembled SERVER-SIDE
// by flight-decision-engine from stored, owned records + fresh weather — the
// former engine took trajectory score, conflicts and weather from the request
// body, so a modified client could save a GO.

export type Decision = "GO" | "DELAY" | "REROUTE";

export interface RouteAlt { id: string; label: string; traffic_score?: number }

export interface DecisionInputs {
  trajectoryScore: number;
  conflicts: number;
  conflictCheck: "checked_clear" | "conflicts" | "incomplete" | null;
  weather: { available: false } | {
    available: true; riskScore: number; forecast15: number; forecast30: number;
    trend: "improving" | "degrading" | "stable";
  };
  /** null = airspace scheduler did not run / failed. */
  airspace: null | { allocated: boolean; delayMinutes: number | null; loadPct: number };
  /** null = coordinator did not run; checked=false = no registered vertiport near either end. */
  vertiport: null | { checked: boolean; reserved: boolean; delayMinutes: number | null };
  route: null | { primaryId: string; primaryScore: number; alternates: RouteAlt[] };
  departureStart: Date;
  userConfidenceAdj: number;
}

export interface DecisionResult {
  decision: Decision;
  reason: string;
  confidence: number;
  delayMinutes: number;
  departureTime: Date;
  routeCandidateId: string | null;
  notes: string[];
  simulation: { safe: boolean; predicted_conflicts: number; weather_at_arrival: string; energy_adequate: boolean; airspace_clear: boolean };
}

const level = (s: number) => (s >= 60 ? "high" : s >= 30 ? "moderate" : "low");

export function decide(i: DecisionInputs): DecisionResult {
  const notes: string[] = [];
  const wx = i.weather;
  const wxScore = wx.available ? wx.riskScore : null;
  const routeScore = i.route?.primaryScore ?? i.trajectoryScore;
  const alts = i.route?.alternates ?? [];
  const airspaceDelay = i.airspace?.allocated ? (i.airspace.delayMinutes ?? 0) : 0;
  const vertiportDelay = i.vertiport?.reserved ? (i.vertiport.delayMinutes ?? 0) : 0;
  const loadPct = i.airspace?.loadPct ?? 0;

  let decision: Decision;
  let reason: string;
  let confidence: number;
  let delay = 0;
  let candidate: string | null = i.route?.primaryId ?? null;

  if (!wx.available) {
    decision = "DELAY"; delay = 10; confidence = 50;
    reason = "Live weather for the departure time is unavailable — holding 10 minutes for re-evaluation. A GO is never issued without weather data.";
  } else if (i.airspace && !i.airspace.allocated) {
    decision = "DELAY"; delay = 60; confidence = 82;
    reason = `No airspace slot available in this altitude band within 60 minutes (load ${loadPct}%). Re-file for a later window.`;
  } else if (i.vertiport && i.vertiport.checked && !i.vertiport.reserved) {
    decision = "DELAY"; delay = 60; confidence = 82;
    reason = "No vertiport departure/arrival slot available within 60 minutes. Re-file for a later window.";
  } else if (wxScore! >= 60) {
    if (wx.trend === "improving" && wx.forecast30 < 40) {
      decision = "DELAY"; delay = 30; confidence = 78;
      reason = `High weather risk at departure (${wxScore}/100); forecast improves to ${wx.forecast30}/100 within 30 minutes — delay recommended.`;
    } else if (alts.length > 0) {
      decision = "REROUTE"; candidate = alts[0].id; confidence = 72;
      reason = `High weather risk on the primary corridor (${wxScore}/100). Rerouting via ${alts[0].label}.`;
    } else {
      decision = "DELAY"; delay = 20; confidence = 70;
      reason = `High weather risk (${wxScore}/100) with no alternate route. Delay 20 minutes.`;
    }
  } else if (i.conflicts >= 3) {
    if (alts.length > 0) {
      const alt = alts.find((r) => (r.traffic_score ?? 0) >= 70) ?? alts[0];
      decision = "REROUTE"; candidate = alt.id; confidence = 80;
      reason = `${i.conflicts} predicted conflicts on the primary route. Rerouting via ${alt.label}.`;
    } else {
      decision = "DELAY"; delay = 15; confidence = 75;
      reason = `${i.conflicts} predicted conflicts. Delay 15 minutes to let traffic clear.`;
    }
  } else if (loadPct >= 80 || airspaceDelay > 0) {
    decision = "DELAY"; delay = airspaceDelay || 15; confidence = 85;
    reason = `Airspace band at ${loadPct}% of hourly capacity. Next reserved slot in ${delay} minutes.`;
  } else if (vertiportDelay > 0) {
    if (i.trajectoryScore >= 75 && wxScore! < 40 && i.conflicts === 0) {
      decision = "GO"; confidence = 82;
      reason = `Vertiport slot reserved ${vertiportDelay} min after the requested time. All other conditions nominal.`;
    } else {
      decision = "DELAY"; delay = vertiportDelay; confidence = 88;
      reason = `Vertiport capacity requires a ${vertiportDelay}-minute departure delay.`;
    }
  } else if (i.trajectoryScore < 55) {
    if (routeScore > i.trajectoryScore + 15 && i.route) {
      decision = "REROUTE"; confidence = 76;
      reason = `Low trajectory score (${i.trajectoryScore}/100). The optimized route scores ${routeScore}/100.`;
    } else {
      decision = "DELAY"; delay = 20; confidence = 68;
      reason = `Low trajectory score (${i.trajectoryScore}/100) — conditions insufficient for departure. Delay 20 minutes.`;
    }
  } else if (i.trajectoryScore < 75 && (i.conflicts >= 1 || wxScore! >= 30)) {
    if (routeScore >= 80 && i.route) {
      decision = "REROUTE"; confidence = 79;
      reason = `Suboptimal trajectory (${i.trajectoryScore}/100) with ${i.conflicts} conflict(s). Optimized route scores ${routeScore}/100.`;
    } else {
      decision = "DELAY"; delay = 10; confidence = 74;
      reason = `Moderate trajectory issues (score ${i.trajectoryScore}/100). 10-minute hold for conditions to stabilise.`;
    }
  } else {
    decision = "GO";
    confidence = Math.min(98, 85 + Math.floor((i.trajectoryScore - 75) / 5));
    reason = `All inputs nominal: trajectory ${i.trajectoryScore}/100, weather ${level(wxScore!)} (${wxScore}/100) at departure, ${i.conflicts} conflict(s).`;
  }

  // Data-quality penalties — stated, never hidden.
  if (i.airspace === null) { confidence -= 15; notes.push("Airspace capacity was not assessed."); }
  if (i.vertiport === null) { confidence -= 10; notes.push("Vertiport capacity was not assessed."); }
  else if (!i.vertiport.checked) notes.push("No registered vertiport within 3 km of an endpoint — pad capacity not checked.");
  if (i.conflictCheck === "incomplete") { confidence -= 10; notes.push("Conflict check incomplete — some traffic lacked position or time data."); }
  confidence = Math.max(10, Math.min(98, Math.round(confidence + i.userConfidenceAdj)));

  const totalDelay = Math.max(delay, airspaceDelay, vertiportDelay);
  if (decision === "DELAY") delay = totalDelay;
  const departureTime = new Date(i.departureStart.getTime() + (decision === "DELAY" ? delay : totalDelay) * 60_000);
  if (notes.length) reason = `${reason} ${notes.join(" ")}`;

  return {
    decision, reason, confidence,
    delayMinutes: decision === "DELAY" ? delay : totalDelay,
    departureTime,
    routeCandidateId: candidate,
    notes,
    simulation: {
      safe: wx.available && i.trajectoryScore >= 70 && wxScore! < 60,
      predicted_conflicts: i.conflicts,
      weather_at_arrival: wx.available ? level(wx.forecast15) : "unknown",
      energy_adequate: i.trajectoryScore >= 50,
      airspace_clear: loadPct < 80,
    },
  };
}
