// Files a flight intent and runs the first-pass analysis (Step 2 entry point).
//
//  • Idempotent: the client sends an idempotency_key; a retry or double-click
//    returns the same intent instead of filing a duplicate that would then show
//    up as phantom traffic for everyone else.
//  • Coordinates are resolved once and stored on the intent.
//  • Conflicts use the shared spatiotemporal engine on ABSOLUTE time (the old
//    check compared origin strings and minutes-of-day, ignoring the date).
//  • Weather is the forecast AT the departure time; if it's unavailable the
//    risk is "unknown" — never silently "low".
import { serve, httpError } from "../_shared/http.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { checkRateLimit, tooManyRequests } from "../_shared/ratelimit.ts";
import { resolveLocation } from "../_shared/geocode.ts";
import { readBody, validateFields } from "../_shared/validate.ts";
import { parseDepartureWindow, epochMinutes } from "../_shared/departure.ts";
import { checkNetwork, type ConflictResult } from "../_shared/conflicts.ts";
import { loadTraffic, trackFromRow } from "../_shared/traffic.ts";
import { fetchWeather, computeRisk, riskLevel } from "../_shared/weather.ts";
import { EVTOL_BASE_SPEED_KMH } from "../_shared/constants.ts";
import { trafficLabel } from "../_shared/anonymize.ts";
import { logInfo } from "../_shared/log.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve("trajectory-analysis", async ({ req, admin, json, cors, setUser }) => {
  const user = await requireUserAuth(req);
  setUser(user.id);

  const rl = await checkRateLimit(admin, user.id, "trajectory-analysis", 30, 60);
  if (!rl.allowed) return tooManyRequests(cors, rl.windowSeconds);

  const body = validateFields(await readBody(req), {
    aircraft_id:            { required: true, type: "string", maxLength: 32, pattern: /^[A-Za-z0-9\-_]+$/ },
    operator_name:          { required: true, type: "string", maxLength: 120 },
    aircraft_type:          { required: true, type: "string", oneOf: ["evtol", "rotorcraft", "hybrid"] },
    origin:                 { required: true, type: "string", maxLength: 256 },
    destination:            { required: true, type: "string", maxLength: 256 },
    altitude_band:          { required: true, type: "string", oneOf: ["low", "mid", "high"] },
    departure_window_start: { required: true, type: "string", maxLength: 5, pattern: /^\d{2}:\d{2}$/ },
    departure_window_end:   { required: true, type: "string", maxLength: 5, pattern: /^\d{2}:\d{2}$/ },
    departure_start_at:     { required: true, type: "string", maxLength: 40 },
    departure_end_at:       { required: true, type: "string", maxLength: 40 },
    idempotency_key:        { type: "string", maxLength: 36, pattern: UUID },
    contingency_landing:    { type: "string", maxLength: 256 },
    max_speed:              { type: "string", maxLength: 16 },
    max_altitude:           { type: "string", maxLength: 16 },
  }) as Record<string, string | undefined>;

  const win = parseDepartureWindow(body.departure_start_at, body.departure_end_at);
  if (!win.ok) throw httpError(400, "Validation failed", { details: win.errors });
  const { start, end } = win.window;
  const key = body.idempotency_key ?? null;

  // ── Idempotency ───────────────────────────────────────────────────────────
  let intentId: string | null = null;
  if (key) {
    const { data: existing } = await admin.from("flight_intents")
      .select("id, analysis_result").eq("user_id", user.id).eq("idempotency_key", key).maybeSingle();
    if (existing?.analysis_result) return json({ ...existing.analysis_result, replayed: true });
    if (existing) intentId = existing.id;
  }

  const [o, d] = await Promise.all([resolveLocation(admin, body.origin), resolveLocation(admin, body.destination)]);
  const coordsStatus = o && d ? "resolved" : o || d ? "partial" : "unresolved";

  if (!intentId) {
    const { data: saved, error } = await admin.from("flight_intents").insert({
      user_id: user.id,
      aircraft_id: body.aircraft_id, operator_name: body.operator_name, aircraft_type: body.aircraft_type,
      origin: body.origin, destination: body.destination, altitude_band: body.altitude_band,
      departure_window_start: body.departure_window_start, departure_window_end: body.departure_window_end,
      departure_start_at: start.toISOString(), departure_end_at: end.toISOString(),
      scheduled_departure: start.toISOString(),
      origin_lat: o?.lat ?? null, origin_lon: o?.lon ?? null, dest_lat: d?.lat ?? null, dest_lon: d?.lon ?? null,
      coords_status: coordsStatus,
      contingency_landing: body.contingency_landing || null,
      max_speed: body.max_speed || null, max_altitude: body.max_altitude || null,
      idempotency_key: key, status: "analyzing",
    }).select("id").single();
    if (error) {
      if (error.code === "23505" && key) {
        // Lost a race with a concurrent submit of the same request.
        const { data: winner } = await admin.from("flight_intents")
          .select("id, analysis_result").eq("user_id", user.id).eq("idempotency_key", key).single();
        if (winner?.analysis_result) return json({ ...winner.analysis_result, replayed: true });
        return json({ error: "This flight intent is already being analysed. Retry in a moment." }, 409);
      }
      throw new Error(`Failed to save intent: ${error.message}`);
    }
    intentId = saved.id;
  }

  // ── Conflicts against live traffic ───────────────────────────────────────
  const traffic = await loadTraffic(admin, { start, end, excludeId: intentId });
  const candidate = trackFromRow({
    id: intentId!, user_id: user.id, aircraft_id: body.aircraft_id!, altitude_band: body.altitude_band!,
    status: "analyzing", departure_start_at: start.toISOString(), departure_end_at: end.toISOString(),
    origin_lat: o?.lat ?? null, origin_lon: o?.lon ?? null, dest_lat: d?.lat ?? null, dest_lon: d?.lon ?? null,
  });
  // Other operators' registrations are never revealed.
  const others = traffic.map((r) => trackFromRow(r, r.user_id === user.id ? r.aircraft_id : trafficLabel(r.id)));
  const check: ConflictResult = checkNetwork(candidate, others);
  const conflicts = check.conflicts.map((c) => ({
    aircraft_id: c.otherId,
    conflict_type: `${c.type} · ${c.horizontalSepKm.toFixed(2)} km min separation · ${c.timeOverlapMin} min overlap`,
    severity: c.severity,
  }));

  // ── Weather at departure ─────────────────────────────────────────────────
  const wx = o ? await fetchWeather(o.lat, o.lon, start) : null;
  const wxRisk = wx?.available ? riskLevel(computeRisk(wx.windSpeedKmh, wx.windGustsKmh, wx.precipitationMm, wx.weatherCode)) : "unknown";

  // ── Score (same weighting as before, real inputs) ────────────────────────
  let score = 80;
  for (const c of conflicts) score -= c.severity === "high" ? 20 : c.severity === "moderate" ? 10 : 5;
  if (wxRisk === "high") score -= 25; else if (wxRisk === "moderate") score -= 12; else if (wxRisk === "unknown") score -= 8;
  if (check.status === "incomplete") score -= 10;
  if (conflicts.length === 0 && wxRisk === "low" && check.status === "checked_clear") score += 15;
  score = Math.max(10, Math.min(100, score));

  const distanceKm = o && d
    ? 2 * 6371 * Math.asin(Math.sqrt(Math.sin(((d.lat - o.lat) * Math.PI) / 360) ** 2 +
        Math.cos((o.lat * Math.PI) / 180) * Math.cos((d.lat * Math.PI) / 180) * Math.sin(((d.lon - o.lon) * Math.PI) / 360) ** 2))
    : null;

  const result = {
    intent_id: intentId,
    conflicts: conflicts.length,
    conflict_details: conflicts,
    conflict_check: {
      status: check.status, method: check.method,
      evaluated_flights: check.evaluatedCount, skipped_flights: check.skipped.length,
      generated_at: new Date().toISOString(),
    },
    trajectory_score: score,
    weather_risk: wxRisk,
    weather_details: wx?.available
      ? { valid_at: wx.validAt, temperature: wx.temperatureC, wind_speed: wx.windSpeedKmh, wind_gusts: wx.windGustsKmh,
          precipitation: wx.precipitationMm, weather_code: wx.weatherCode, visibility: wx.visibilityM }
      : { error: o ? "Weather forecast unavailable for the departure time" : "Origin location could not be resolved" },
    coords_status: coordsStatus,
    departure: { start: start.toISOString(), end: end.toISOString(), epoch_minutes: epochMinutes(start) },
    distance_km: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
    estimated_time_min: distanceKm != null ? Math.round((distanceKm / EVTOL_BASE_SPEED_KMH) * 600) / 10 : null,
    existing_intents_checked: check.evaluatedCount,
  };

  const { error: upErr } = await admin.from("flight_intents").update({
    conflicts: conflicts.length, trajectory_score: score, weather_risk: wxRisk,
    status: "pending", analysis_result: result,
  }).eq("id", intentId!);
  if (upErr) throw new Error(`Failed to store analysis: ${upErr.message}`);

  logInfo("trajectory-analysis", "analysed", { intent: intentId, conflicts: conflicts.length, score, wxRisk, coordsStatus });
  return json(result);
});
