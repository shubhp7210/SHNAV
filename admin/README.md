# SHNAV admin map

A private, single-file admin site (`index.html`): live map of every active tracker and website flight,
flight history with routes, and tracker management. It is deliberately **separate from the main app**
(not part of the Vite build, not covered by the app's CSP) so it can be hosted anywhere or opened locally.

Only accounts listed in `public.admins` can see data. The page only holds the public publishable key; every
row is protected by RLS (`supabase/migrations/20261122000000_admin_tracking.sql`).

## Run it
- **Locally:** double-click `index.html` (Chrome or Safari) and sign in with your SHNAV account.
- **Hosted:** drag this folder onto https://app.netlify.com/drop (or any static host).

## Make someone an admin
```sql
INSERT INTO public.admins (user_id) SELECT id FROM auth.users WHERE email = 'you@example.com';
```

## Trackers
Each tracker has a secret device token (Trackers tab). A device sends:

```
POST https://jiagegvlehrawpxcrwsd.supabase.co/functions/v1/ping
X-Device-Token: <token>
Content-Type: application/json

{"lat": 40.73, "lng": -74.34, "altitude": 120, "speed": 25, "heading": 90, "accuracy": 5}
```
Units: metres, m/s, degrees. Responses: `200` ok · `401` bad token · `404` nothing active · `429` too fast.

- **Start tracker flight** — the pings are logged as the tracker's own flight (`flights` / `location_pings`).
- **Link aircraft…** — set the aircraft ID a pilot files on the website. While that pilot's flight with that
  aircraft ID is airborne, every ping is also sent through `ingest_telemetry()`, so it becomes real GPS telemetry
  for the website flight (live position, and it can mark the past flight **verified**). A tracker only ever feeds
  flights of its own linked account.

Test without hardware: `DEVICE_TOKEN=<token> node scripts/fake-tracker.mjs`.
