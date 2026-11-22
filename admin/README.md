# SHNAV admin map

A private admin website, **separate from the main app**: live map of every active tracker and
website flight, flight history with routes, and tracker management.

## Run it

```bash
npm run admin        # → http://localhost:8090   (the main app stays on http://localhost:8080)
```

It is a single file (`index.html`), not part of the main app's build, so it can later be hosted on
its own domain (any static host). If you do, add that address to Supabase → Authentication →
URL Configuration → Redirect URLs.

## Signing in (owner only)

1. Enter the admin email (`shubh.p7210@gmail.com`). Any other email is refused.
2. Supabase emails a one-time sign-in **link** (or a **code**, if you set up custom SMTP and add
   `{{ .Token }}` to the "Magic link or OTP" template). Open the link in the same browser, or type the code.
3. You're in. Closing the tab signs you out; a sign-in is valid for at most 24 hours.

**What actually protects the data** is the database, not this page: every admin read/write
goes through `public.is_admin()`, which requires **both**

- the account is listed in `public.admins`, **and**
- the session was opened with an emailed link/code in the last 24 h (JWT `amr` = otp/magiclink).

So a password session (for example your normal sign-in on the main site) or a copied/edited version
of this page gets nothing. No account can be created from this page (`shouldCreateUser: false`).

To add another admin later:
```sql
INSERT INTO public.admins (user_id) SELECT id FROM auth.users WHERE email = 'someone@example.com';
```
and add their email to `ADMIN_EMAIL` in `index.html` (or make it a list).

## Trackers

Each tracker has a secret device token (Trackers tab). A device sends:

```
POST https://jiagegvlehrawpxcrwsd.supabase.co/functions/v1/ping
X-Device-Token: <token>
Content-Type: application/json

{"lat": 40.73, "lng": -74.34, "altitude": 120, "speed": 25, "heading": 90, "accuracy": 5}
```
Units: metres, m/s, degrees. Responses: `200` ok · `400` bad position · `401` bad token ·
`404` nothing active · `429` too fast (limit 120 pings/min).

- **Start tracker flight**: pings are logged as the tracker's own session (`flights` / `location_pings`).
- **Link aircraft…**: set the aircraft ID you file flights with on the website. While your flight with that
  aircraft ID is airborne, each ping becomes real GPS telemetry for it:
  the **website shows you the tracker's live position** ("Live position from linked tracker"), and the
  flight can be marked **verified** when it lands. A tracker only ever feeds flights of its linked account.

Test without hardware: `DEVICE_TOKEN=<token> node scripts/fake-tracker.mjs`.
