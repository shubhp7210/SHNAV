-- Plain-English descriptions for every table and view (2026-11-22).
-- They show up in the Supabase dashboard (Table Editor → table → description) and in generated docs.
-- Comments only: no data or behaviour changes. Tables missing in an environment are skipped.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- ── Flights on the website ──────────────────────────────────────────────
    ('flight_intents',          'TABLE', 'Website: every flight a pilot files (origin, destination, departure window). Status moves pending → approved → in_air → landed; ended flights are copied to past_flights.'),
    ('flight_decisions',        'TABLE', 'Website: the GO / DELAY / REROUTE decision for a filed flight, with reason and confidence. A newer decision supersedes the old one.'),
    ('routes',                  'TABLE', 'Website: the planned route (primary + alternates) and its scores for a filed flight.'),
    ('flight_telemetry',        'TABLE', 'Website: GPS fixes received during a flight, validated server-side (quality ok / suspect / rejected). source = phone (pilot''s browser GPS) or tracker (linked device).'),
    ('past_flights',            'TABLE', 'Website: finished flights, append-only. Built from the intent plus its telemetry; only GPS-tracked flights can be "verified". Change only via apply_correction().'),
    ('flight_outcomes',         'TABLE', 'Website: what actually happened on a flight (times, delay, weather met). Input to reconciliation against predictions.'),
    ('prediction_errors',       'TABLE', 'Learning: predicted vs observed values per past flight (duration, wind, ...).'),
    ('record_corrections',      'TABLE', 'Audit log: every correction made to a past record — original value, new value, reason, evidence.'),
    ('historical_flights',      'TABLE', 'Legacy (before 2026-11-15): old copy of landed flights. Superseded by past_flights; kept for history.'),
    ('user_error_profiles',     'TABLE', 'Legacy (before 2026-11-15): per-user error statistics. Cleared and superseded by user_pattern_flags.'),
    ('user_pattern_flags',      'TABLE', 'Learning: patterns detected for a pilot (e.g. routinely late). The pilot can confirm or dismiss them.'),
    ('anomalies',               'TABLE', 'Website: anomalies detected during a flight (deviation, conflict, ...).'),
    ('trajectory_updates',      'TABLE', 'Legacy: older per-flight position updates. Live tracking now uses flight_telemetry.'),
    -- ── Airspace, vertiports, scheduling ────────────────────────────────────
    ('vertiports',              'TABLE', 'Reference: landing sites (real FAA heliports/airports active; old fictional ones inactive) with capacity per hour.'),
    ('vertiport_slots',         'TABLE', 'Scheduling: departure/arrival slots reserved at a vertiport for a flight.'),
    ('airspace_segments',       'TABLE', 'Reference: airspace blocks with capacity per hour and no-fly windows.'),
    ('time_slots',              'TABLE', 'Scheduling: airspace capacity reserved by a flight in a segment and time window.'),
    ('route_patterns',          'TABLE', 'Planning statistics: how often each origin → destination pair was flown and its average scores (refreshed nightly).'),
    ('route_score_config',      'TABLE', 'Legacy: route scoring weights before 2026-11-15. Planning now reads the active route_weights in model_params.'),
    ('model_params',            'TABLE', 'Learning: versioned model parameters. Exactly one active version per kind; every version is kept for rollback.'),
    -- ── Real-world data (ingested on a schedule) ────────────────────────────
    ('wx_metar',                'TABLE', 'Weather observations (METAR) from aviationweather.gov.'),
    ('wx_taf',                  'TABLE', 'Weather forecasts for airports (TAF) from aviationweather.gov.'),
    ('wx_advisories',           'TABLE', 'Weather advisories (SIGMET / AIRMET / NWS alerts) with their areas.'),
    ('wx_forecast_snapshots',   'TABLE', 'Open-Meteo forecasts captured at planning time, so they can be checked against what happened.'),
    ('wx_verification',         'TABLE', 'Forecast vs observed weather pairs (forecast snapshot matched to a METAR).'),
    ('airspace_restrictions',   'TABLE', 'Temporary flight restrictions (FAA TFRs) and other restrictions, append-only history.'),
    ('airspace_restrictions_current', 'VIEW', 'Restrictions in force right now (latest version of each, not withdrawn).'),
    ('traffic_observations',    'TABLE', 'Live aircraft positions (ADS-B via OpenSky). Raw rows are kept 14 days.'),
    ('data_sources',            'TABLE', 'Ingestion config and health for each external source: cadence, budget, last success, failures, backoff.'),
    ('data_source_status',      'VIEW',  'Safe summary of data_sources for the app: freshness = fresh / degraded / stale / never / disabled.'),
    ('ingest_runs',             'TABLE', 'One row per ingestion run: source, status, records seen/inserted/duplicate/rejected. Kept 30 days.'),
    ('geocode_cache',           'TABLE', 'Cache of address → coordinates lookups (Nominatim) to save API calls.'),
    -- ── Operations ──────────────────────────────────────────────────────────
    ('error_events',            'TABLE', 'Ops: errors from edge functions and the browser. Kept 30 days. Used by alerting.'),
    ('alert_events',            'TABLE', 'Ops: alerts raised (error spikes, API budget) and their delivery status.'),
    ('api_usage',               'TABLE', 'Ops: calls per external API per day, checked against api_budgets.'),
    ('api_budgets',             'TABLE', 'Ops: daily call limits per external API.'),
    ('rate_limits',             'TABLE', 'Ops: per-user (and per-tracker) request counters for rate limiting.'),
    ('integrity_check_results', 'TABLE', 'Ops: results of the hourly data integrity checks.'),
    -- ── Admin map + trackers ────────────────────────────────────────────────
    ('admins',                  'TABLE', 'Admin map: accounts allowed in. Access also requires signing in with an email code (see is_admin()).'),
    ('vehicles',                'TABLE', 'Admin map: tracker devices. device_token is the device''s secret; owner_user_id + aircraft_id link it to a pilot''s website flight.'),
    ('flights',                 'TABLE', 'Admin map: a tracker''s own tracking sessions (active → completed). Not the website''s flights — those are flight_intents.'),
    ('location_pings',          'TABLE', 'Admin map: every position a tracker reported during a tracker session.')
  ) AS t(name, kind, description) LOOP
    IF to_regclass('public.' || r.name) IS NOT NULL THEN
      EXECUTE format('COMMENT ON %s public.%I IS %L', r.kind, r.name, r.description);
    END IF;
  END LOOP;
END $$;

-- Key functions.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.is_admin()', 'True when the caller is in admins AND signed in with an email code in the last 24 h.'),
    ('public.tracker_ping(text, double precision, double precision, double precision, double precision, double precision, double precision, timestamptz)',
     'Device ping intake (called by the ping edge function): logs the position and feeds a linked pilot''s airborne flight.'),
    ('public.ingest_telemetry(uuid, uuid, jsonb)', 'Validates and stores GPS fixes for a flight (ownership, airborne, timestamps, plausible movement).'),
    ('public.dispatch_ingest()', 'Every minute (pg_cron): asks the data-ingest edge function to fetch sources that are due.'),
    ('public.finalize_flight(uuid, boolean)', 'Moves an ended flight from flight_intents to past_flights.'),
    ('public.check_rate_limit(uuid, text, integer, integer)', 'Fixed-window rate limit counter; true = allowed.')
  ) AS t(sig, description) LOOP
    IF to_regprocedure(r.sig) IS NOT NULL THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.sig, r.description);
    END IF;
  END LOOP;
END $$;
