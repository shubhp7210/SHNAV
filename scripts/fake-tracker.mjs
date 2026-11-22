// Simulated tracker for testing the ping endpoint and the admin map.
//
//   DEVICE_TOKEN=<token from the admin map's Trackers tab> node scripts/fake-tracker.mjs
//
// Optional: PING_URL (defaults to production), START="40.7298,-74.3414", END="40.7439,-74.3375",
// STEPS=40, INTERVAL_MS=3000. Flies START → END in a straight line, one ping per interval.
const PING_URL = process.env.PING_URL ?? "https://jiagegvlehrawpxcrwsd.supabase.co/functions/v1/ping";
const TOKEN = process.env.DEVICE_TOKEN;
if (!TOKEN) { console.error("DEVICE_TOKEN is required"); process.exit(2); }
const parse = (s, d) => (s ?? d).split(",").map(Number);
const [lat0, lng0] = parse(process.env.START, "40.7298,-74.3414");
const [lat1, lng1] = parse(process.env.END, "40.7439,-74.3375");
const STEPS = Number(process.env.STEPS ?? 40);
const INTERVAL = Number(process.env.INTERVAL_MS ?? 3000);

for (let i = 0; i <= STEPS; i++) {
  const f = i / STEPS;
  const body = { lat: lat0 + (lat1 - lat0) * f, lng: lng0 + (lng1 - lng0) * f, altitude: 120, speed: 25, t: new Date().toISOString() };
  const r = await fetch(PING_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Device-Token": TOKEN }, body: JSON.stringify(body) });
  console.log(`${i}/${STEPS}`, r.status, await r.text());
  if (i < STEPS) await new Promise((res) => setTimeout(res, INTERVAL));
}
