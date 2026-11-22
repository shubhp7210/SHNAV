// Tracker position intake. Any device that can make an HTTPS POST can be a tracker:
//
//   POST /functions/v1/ping
//   X-Device-Token: <vehicles.device_token>
//   { "lat": 40.73, "lng": -74.34, "altitude": 120, "speed": 30, "heading": 90, "accuracy": 5, "t": "<ISO time, optional>" }
//
// Units: altitude metres, speed m/s, heading degrees, accuracy metres (same as flight-telemetry).
// Devices are not users, so the gateway does not check a JWT (verify_jwt = false in config.toml);
// the device token is the credential and is checked inside tracker_ping(), which also rate-limits
// per device and, for linked vehicles, feeds the owner's airborne flight via ingest_telemetry().
import { serve, httpError } from "../_shared/http.ts";
import { readBody } from "../_shared/validate.ts";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

serve("ping", async ({ req, admin, json, cors }) => {
  const token = req.headers.get("x-device-token")?.trim() ?? "";
  if (token.length < 32 || token.length > 256) throw httpError(401, "Missing or invalid X-Device-Token");

  const body = (await readBody(req) ?? {}) as Record<string, unknown>;
  const lat = num(body.lat);
  const lng = num(body.lng) ?? num(body.lon);
  if (lat === null || lng === null) {
    throw httpError(400, "Validation failed", { details: ["lat and lng must be numbers"] });
  }
  const t = typeof body.t === "string" && !Number.isNaN(Date.parse(body.t)) ? new Date(body.t).toISOString() : null;

  const { data, error } = await admin.rpc("tracker_ping", {
    p_token: token, p_lat: lat, p_lng: lng,
    p_alt: num(body.altitude ?? body.alt), p_speed: num(body.speed ?? body.spd),
    p_heading: num(body.heading ?? body.hdg), p_accuracy: num(body.accuracy ?? body.acc), p_t: t,
  });
  if (error) throw new Error(`tracker_ping failed: ${error.message}`);

  switch (data?.error) {
    case "bad_token":      throw httpError(401, "Unknown device token");
    case "bad_position":   throw httpError(400, "Validation failed", { details: ["lat/lng out of range"] });
    case "rate_limited":   return new Response(JSON.stringify({ error: "Too many pings; slow down" }),
                             { status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": "60" } });
    case "nothing_active": throw httpError(404, "No active tracker flight and no linked airborne flight for this device");
  }
  return json({ ok: true, ...data });
});
