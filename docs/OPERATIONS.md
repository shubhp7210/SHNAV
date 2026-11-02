# SHNAV operations runbook

Project: `jiagegvlehrawpxcrwsd` (Supabase, Postgres 17) · Deploys: `.github/workflows/deploy.yml` on push to `main`.

Check production at any time (read-only, public key only):

```bash
SUPABASE_URL=https://jiagegvlehrawpxcrwsd.supabase.co SUPABASE_ANON_KEY=<anon key> \
ALLOWED_ORIGIN=https://<your-app-domain> npm run verify:prod
```

---

## 1. First deploy of the 2026-10/11 hardening (one time, in this order)

Production was running the **July 2** backend (`main` @ `e3fb369`): CORS `*`, no gateway JWT,
no rate limiting (table missing), no background jobs. Everything below ships with the merge.

1. **GitHub → Settings → Secrets → Actions**, add:

   | Secret | Value |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | Supabase → Account → Access Tokens |
   | `SUPABASE_DB_PASSWORD` | Project → Settings → Database |
   | `SUPABASE_DB_URL` | Project → Connect → **Session pooler** URI (with password) |
   | `SUPABASE_ANON_KEY` | Project → Settings → API → anon/publishable key |
   | `ALLOWED_ORIGINS` | Comma-separated app origins, e.g. `https://shnav.app,https://www.shnav.app` |
   | `INTERNAL_FUNCTION_SECRET` | `openssl rand -hex 32` |
   | `BACKUP_PASSPHRASE` | `openssl rand -base64 32` (store it in your password manager — backups are useless without it) |

   The deploy **refuses to run** if any are missing. `ALLOWED_ORIGINS` matters most: CORS fails
   closed, so without it the live site's API calls are blocked.
2. Create a GitHub **Environment** named `production` (optionally require a reviewer).
3. Merge `cesium-3d-map` → `main`. CI runs (types, unit, DB/concurrency, function type-check),
   then: pre-deploy encrypted backup → `db push --dry-run` → `db push` → secrets → functions →
   `verify-production.mjs` (fails the run if production isn't hardened).
4. Deploy the **frontend after** the backend (it relies on the new columns and functions).
5. Turn on alert delivery (§4) and spend alarms (§5).

## 2. Rollback

| What | How |
|---|---|
| Edge functions | Actions → *Deploy to Supabase* → **Run workflow** with `ref` = last good SHA, `functions_only` = ✓ |
| A migration | Run `supabase/rollback/<migration>.down.sql` in the SQL editor (**after** rolling functions back — new functions need the new schema), then `DELETE FROM supabase_migrations.schema_migrations WHERE version = '<version>';` |
| Data | Restore the pre-deploy artifact `predeploy-backup-<run_id>` (§3) |
| Frontend | Redeploy the previous build in your host (Netlify/Vercel/CF Pages "rollback" button) |

Every migration from 2026-10-19 onward has a matching `.down.sql`. Down scripts are tested in CI:
the DB suite applies the migration, rolls it back, and re-applies it.

## 3. Backups and restore

- **Nightly** (`backup.yml`, 04:30 UTC): `pg_dump` → restore into a fresh Postgres 17 →
  **fails unless every table's row count matches the source** → encrypted artifact (30 days).
  A red run means the backup did not restore. Check the Actions tab weekly, or add a
  failure notification.
- **Supabase backups:** the Free plan has **none**. Pro includes daily backups (7 days), and PITR is an add-on.
  Enable at least Pro daily backups for production: Project → Database → Backups.
- **Restore a dump:**
  ```bash
  gpg --decrypt backup-<ts>.dump.gpg > backup.dump      # asks for BACKUP_PASSPHRASE
  pg_restore --no-owner --no-privileges --clean --if-exists -d "$TARGET_DB_URL" backup.dump
  ```
  Dumps cover the `public` and `app_private` schemas. User accounts (`auth`) are covered by Supabase's own backups.

## 4. Error tracking and alerts

- Edge functions log structured JSON (Supabase → Edge Functions → Logs) and write failures
  to `public.error_events`. The frontend reports crashes via `log-client-error`.
- `check_alerts()` runs every 5 minutes (pg_cron). It raises **error spikes** (≥10 errors / 15 min)
  and **budget** warnings (80 %) or breaches (100 %), de-duplicated per window. Undelivered alerts are retried up to 5×.
- **Enable delivery** (Slack or Discord incoming-webhook URL) in the SQL editor:
  ```sql
  INSERT INTO app_private.settings VALUES ('alert_webhook_url', 'https://hooks.slack.com/services/…')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  ```
  Until then alerts are still recorded in `public.alert_events`.
- Useful queries:
  ```sql
  SELECT occurred_at, source, fn, message FROM error_events ORDER BY occurred_at DESC LIMIT 50;
  SELECT * FROM alert_events ORDER BY created_at DESC;
  SELECT jobname, schedule, active FROM cron.job;
  SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
  ```

## 5. Spend alarms

**Built in:** `api_usage` counts Open-Meteo, Nominatim and edge-function calls per day. `api_budgets`
holds the daily limits. Tune them with:
`UPDATE api_budgets SET daily_limit = … WHERE service = 'open-meteo';`

**Set these in the provider dashboards. Code can't set them:**

| Service | Where | Recommended |
|---|---|---|
| Supabase | Org → Billing → **Spend cap ON**; Usage → set usage alerts | Cap on; alerts at 75 % of each quota |
| Cesium ion | ion → Account → Usage | Watch tile/asset quota; the free tier is **non-commercial** |
| Hosting (Netlify/Vercel/CF) | Billing → usage notifications | Bandwidth + function alerts |
| GitHub Actions | Settings → Billing → spending limit | $0 limit, or a fixed cap |

## 6. Background jobs (pg_cron)

| Job | Schedule (UTC) | Does |
|---|---|---|
| `shnav-expire-stale-intents` | every 5 min | Expires abandoned intents and frees their slots |
| `shnav-check-alerts` | every 5 min | Raises and delivers alerts |
| `shnav-prune` | hourly :07 | Rate-limit windows >1 day, errors >30 days, stale negative geocodes |
| `shnav-refresh-patterns` | 03:15 daily | Fleet route-pattern refresh + safety weight adjustment |

Jobs run inside Postgres, so they never block requests. Manual pattern refresh: POST
`/functions/v1/background-analyzer` with `X-Internal-Secret`.

## 7. Data sources and licensing (check before commercial launch)

| Data | Source | Note |
|---|---|---|
| Weather | Open-Meteo 15-min forecast at the departure time | **Free API is non-commercial only**. Commercial use needs a paid plan or self-hosting |
| Geocoding | OSM Nominatim, cached in `geocode_cache`, ≤1 req/s | Policy: no heavy use. Consider a paid geocoder at scale |
| 3D terrain/buildings | Cesium ion | Free tier is non-commercial ("Upgrade for commercial use" credit) |
| Basemap | Esri World Dark Gray (keyless) | Commercial use needs an ArcGIS account |
| Vertiports | FAA-registered sites (JRB, 6N5, JRA, JFK, LGA, EWR) | Hourly capacities are **configured planning values**. No public data exists |
| Airspace restrictions | `airspace_segments` (static) | **Not** live FAA TFRs, so it isn't suitable for real operations |
