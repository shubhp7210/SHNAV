-- ============================================================================
-- Aviation data platform (2026-11-15)
-- ============================================================================
-- Rollback: supabase/rollback/20261115000000_data_platform.down.sql
--
--  0. Archive + reset of learned state that the audit found contaminated
--     (circular route-pattern "outcome" scores, per-flight weight nudging,
--     silent per-user confidence penalties). Originals are copied to schema
--     archive_20261115 first — nothing is lost.
--  1. Source registry + ingest runs (leases, backoff, ETag, alerts).
--  2. Immutable observation stores: METAR, TAF, SIGMET/AIRMET/G-AIRMET/NWS
--     advisories, FAA TFRs, ADS-B traffic, forecast snapshots + verification.
--  3. Flight telemetry (server-validated GPS fixes).
--  4. Active vs Past flights: flight_intents is the ACTIVE store; a flight is
--     moved to past_flights (self-contained dossier) only once its end is
--     confirmed or timed out. Past rows are append-only; changes go through
--     apply_correction(), which keeps the original value + evidence.
--  5. Leakage guard: planning code (service_role) has NO privileges on
--     past_flights / prediction_errors / wx_verification. It only reads
--     promoted, versioned model_params. Training reads data "as of" a time.
--  6. Reconciliation (predicted vs observed), self-correction, training with
--     a time-ordered holdout gate, user error-pattern flags (confirm/dismiss).
--  7. Integrity checks, retention, pg_cron schedules.
-- This is a research/simulation system — not a certified flight-safety system.
-- ============================================================================

-- ─── Helpers ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.geo_dist_m(lat1 double precision, lon1 double precision,
                                             lat2 double precision, lon2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)))
$$;

-- Minimum distance (m) from a point to a polyline [{lat,lon},...] using a local
-- equirectangular projection (accurate to <0.5% over metro distances).
CREATE OR REPLACE FUNCTION public.dist_to_polyline_m(p_lat double precision, p_lon double precision, p_line jsonb)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n integer := COALESCE(jsonb_array_length(p_line), 0);
  k double precision := cos(radians(p_lat)) * 111320.0;
  best double precision := NULL; i integer;
  x1 double precision; y1 double precision; x2 double precision; y2 double precision;
  dx double precision; dy double precision; t double precision; d double precision;
BEGIN
  IF n = 0 THEN RETURN NULL; END IF;
  IF n = 1 THEN
    RETURN geo_dist_m(p_lat, p_lon, (p_line->0->>'lat')::float8, (p_line->0->>'lon')::float8);
  END IF;
  FOR i IN 0 .. n - 2 LOOP
    x1 := ((p_line->i->>'lon')::float8 - p_lon) * k;       y1 := ((p_line->i->>'lat')::float8 - p_lat) * 110540.0;
    x2 := ((p_line->(i+1)->>'lon')::float8 - p_lon) * k;   y2 := ((p_line->(i+1)->>'lat')::float8 - p_lat) * 110540.0;
    dx := x2 - x1; dy := y2 - y1;
    IF dx = 0 AND dy = 0 THEN t := 0;
    ELSE t := GREATEST(0, LEAST(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy))); END IF;
    d := sqrt(power(x1 + t * dx, 2) + power(y1 + t * dy, 2));
    IF best IS NULL OR d < best THEN best := d; END IF;
  END LOOP;
  RETURN best;
END $$;

-- ─── 0. Archive, then reset contaminated learned state ──────────────────────
CREATE SCHEMA IF NOT EXISTS archive_20261115;
REVOKE ALL ON SCHEMA archive_20261115 FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS archive_20261115.route_patterns      AS SELECT * FROM public.route_patterns;
CREATE TABLE IF NOT EXISTS archive_20261115.route_score_config  AS SELECT * FROM public.route_score_config;
CREATE TABLE IF NOT EXISTS archive_20261115.user_error_profiles AS SELECT * FROM public.user_error_profiles;
CREATE TABLE IF NOT EXISTS archive_20261115.historical_flights  AS SELECT * FROM public.historical_flights;
CREATE TABLE IF NOT EXISTS archive_20261115.flight_outcomes     AS SELECT * FROM public.flight_outcomes;

-- "Outcome-adjusted" scores compared a heuristic to the prediction (not an
-- observation) — they carry no information about real outcomes.
UPDATE public.route_patterns SET
  completed_flight_count = 0, avg_actual_delay_minutes = 0, avg_actual_duration_minutes = NULL,
  outcome_adjusted_score = NULL, systematic_error = 0;
-- Silent per-user penalties are replaced by explicit, user-confirmed flags.
DELETE FROM public.user_error_profiles;

-- ─── 1. Source registry + ingest runs ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_sources (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('weather_obs','weather_fcst','advisory','restriction','traffic')),
  url                  text NOT NULL,
  cadence_seconds      integer,              -- NULL = on-demand only
  reliability          numeric NOT NULL CHECK (reliability BETWEEN 0 AND 1),
  run_condition        text NOT NULL DEFAULT 'always' CHECK (run_condition IN ('always','active_flights')),
  enabled              boolean NOT NULL DEFAULT true,
  budget_service       text,
  licence              text,
  next_run_at          timestamptz,
  lease_until          timestamptz,
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  last_data_at         timestamptz,          -- newest valid/observed time actually stored
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  backoff_until        timestamptz,
  etag                 text,
  last_modified        text
);
ALTER TABLE public.data_sources ENABLE ROW LEVEL SECURITY;

INSERT INTO public.data_sources (id, name, kind, url, cadence_seconds, reliability, run_condition, budget_service, licence) VALUES
  ('awc-metar',     'AviationWeather.gov METAR',          'weather_obs',  'https://aviationweather.gov/api/data/metar',      300, 0.95, 'always',         'awc',     'US Government public domain'),
  ('awc-taf',       'AviationWeather.gov TAF',            'weather_fcst', 'https://aviationweather.gov/api/data/taf',       1800, 0.90, 'always',         'awc',     'US Government public domain'),
  ('awc-airsigmet', 'AviationWeather.gov SIGMET/AIRMET',  'advisory',     'https://aviationweather.gov/api/data/airsigmet',  900, 0.90, 'always',         'awc',     'US Government public domain'),
  ('awc-gairmet',   'AviationWeather.gov G-AIRMET',       'advisory',     'https://aviationweather.gov/api/data/gairmet',   1800, 0.85, 'always',         'awc',     'US Government public domain'),
  ('nws-alerts',    'NWS active alerts',                  'advisory',     'https://api.weather.gov/alerts/active',           600, 0.90, 'always',         'nws',     'US Government public domain'),
  ('faa-tfr',       'FAA Temporary Flight Restrictions',  'restriction',  'https://tfr.faa.gov/tfrapi/exportTfrList',        900, 0.95, 'always',         'faa-tfr', 'US Government public domain'),
  ('opensky',       'OpenSky Network ADS-B state vectors','traffic',      'https://opensky-network.org/api/states/all',      300, 0.70, 'active_flights', 'opensky', 'OpenSky terms: non-commercial research use'),
  ('open-meteo-verif','Open-Meteo forecast (verification snapshots)','weather_fcst','https://api.open-meteo.com/v1/forecast', 3600, 0.80, 'always', 'open-meteo', 'CC BY 4.0, non-commercial free tier'),
  ('open-meteo',    'Open-Meteo forecast (planning, on demand)','weather_fcst','https://api.open-meteo.com/v1/forecast',     NULL, 0.80, 'always',         'open-meteo', 'CC BY 4.0, non-commercial free tier')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, kind = EXCLUDED.kind,
  reliability = EXCLUDED.reliability, run_condition = EXCLUDED.run_condition,
  budget_service = EXCLUDED.budget_service, licence = EXCLUDED.licence;

INSERT INTO public.api_budgets (service, daily_limit, note) VALUES
  ('awc', 5000, 'aviationweather.gov Data API: keep well under 100 req/min'),
  ('nws', 3000, 'api.weather.gov: no hard quota; identify via User-Agent'),
  ('faa-tfr', 2000, 'tfr.faa.gov list + detail XML'),
  ('opensky', 380, 'Anonymous: 400 credits/day. Raise to ~3800 when OPENSKY credentials are set')
ON CONFLICT (service) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ingest_runs (
  id               bigserial PRIMARY KEY,
  source_id        text NOT NULL REFERENCES public.data_sources(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','ok','not_modified','partial','error','skipped')),
  http_status      integer,
  records_seen     integer NOT NULL DEFAULT 0,
  records_inserted integer NOT NULL DEFAULT 0,
  records_duplicate integer NOT NULL DEFAULT 0,
  records_rejected integer NOT NULL DEFAULT 0,
  error            text
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_source_time ON public.ingest_runs (source_id, started_at DESC);
ALTER TABLE public.ingest_runs ENABLE ROW LEVEL SECURITY;

-- Claim a run. The conditional UPDATE is the lock: concurrent callers re-check
-- the WHERE after the row lock is released, so only one obtains the lease.
CREATE OR REPLACE FUNCTION public.ingest_claim(p_source text, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_src data_sources; v_run bigint;
BEGIN
  UPDATE data_sources SET lease_until = now() + interval '3 minutes', last_attempt_at = now()
  WHERE id = p_source AND enabled
    AND (lease_until IS NULL OR lease_until < now())
    AND (p_force OR ((backoff_until IS NULL OR backoff_until <= now())
                     AND (next_run_at IS NULL OR next_run_at <= now())))
  RETURNING * INTO v_src;
  IF v_src.id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO ingest_runs (source_id) VALUES (p_source) RETURNING id INTO v_run;
  RETURN jsonb_build_object('run_id', v_run, 'source', v_src.id, 'url', v_src.url,
    'etag', v_src.etag, 'last_modified', v_src.last_modified, 'budget_service', v_src.budget_service);
END $$;

CREATE OR REPLACE FUNCTION public.ingest_finish(
  p_run bigint, p_status text, p_http integer DEFAULT NULL,
  p_seen integer DEFAULT 0, p_inserted integer DEFAULT 0, p_duplicate integer DEFAULT 0, p_rejected integer DEFAULT 0,
  p_error text DEFAULT NULL, p_etag text DEFAULT NULL, p_last_modified text DEFAULT NULL,
  p_retry_after_s integer DEFAULT NULL, p_last_data_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_src text; v_fail integer; v_cad integer; v_backoff interval;
BEGIN
  UPDATE ingest_runs SET finished_at = now(), status = p_status, http_status = p_http,
    records_seen = p_seen, records_inserted = p_inserted, records_duplicate = p_duplicate,
    records_rejected = p_rejected, error = left(p_error, 2000)
  WHERE id = p_run AND finished_at IS NULL
  RETURNING source_id INTO v_src;
  IF v_src IS NULL THEN RETURN; END IF;   -- unknown or already finished
  SELECT COALESCE(cadence_seconds, 3600) INTO v_cad FROM data_sources WHERE id = v_src;

  IF p_status IN ('ok', 'not_modified', 'partial', 'skipped') THEN
    UPDATE data_sources SET lease_until = NULL,
      last_success_at = CASE WHEN p_status = 'skipped' THEN last_success_at ELSE now() END,
      last_data_at = GREATEST(last_data_at, p_last_data_at),
      consecutive_failures = CASE WHEN p_status = 'skipped' THEN consecutive_failures ELSE 0 END,
      backoff_until = NULL, last_error = CASE WHEN p_status = 'partial' THEN left(p_error, 500) ELSE NULL END,
      etag = COALESCE(p_etag, etag), last_modified = COALESCE(p_last_modified, last_modified),
      next_run_at = now() + make_interval(secs => v_cad)
    WHERE id = v_src;
  ELSE
    UPDATE data_sources SET consecutive_failures = consecutive_failures + 1, last_error = left(p_error, 500)
    WHERE id = v_src RETURNING consecutive_failures INTO v_fail;
    -- Exponential backoff (cadence × 2^(n-1), capped at 6 h) or the server's Retry-After.
    v_backoff := CASE WHEN p_retry_after_s IS NOT NULL THEN make_interval(secs => LEAST(p_retry_after_s, 21600))
                      ELSE make_interval(secs => LEAST(21600, v_cad * power(2, LEAST(v_fail, 12) - 1))) END;
    UPDATE data_sources SET lease_until = NULL, backoff_until = now() + v_backoff, next_run_at = now() + v_backoff
    WHERE id = v_src;
    IF v_fail >= 3 THEN
      INSERT INTO alert_events (kind, dedupe_key, message, details)
      VALUES ('source_failing', 'source_failing:' || v_src || ':' || to_char(date_trunc('hour', now()), 'YYYY-MM-DD"T"HH24'),
              format('SHNAV: data source %s failed %s times in a row (%s)', v_src, v_fail, left(p_error, 200)),
              jsonb_build_object('source', v_src, 'failures', v_fail, 'http_status', p_http))
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;
  END IF;
END $$;

-- A flight is "in operation" if it is airborne or departs within ±30 min.
CREATE OR REPLACE FUNCTION public.has_active_operations()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM flight_intents
    WHERE status IN ('in_air', 'active')
       OR (status IN ('pending', 'approved')
           AND departure_start_at BETWEEN now() - interval '30 minutes' AND now() + interval '30 minutes'))
$$;

CREATE OR REPLACE FUNCTION public.ingest_due_sources()
RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM data_sources
  WHERE enabled AND cadence_seconds IS NOT NULL
    AND (lease_until IS NULL OR lease_until < now())
    AND (backoff_until IS NULL OR backoff_until <= now())
    AND (next_run_at IS NULL OR next_run_at <= now())
    AND (run_condition = 'always' OR has_active_operations())
  ORDER BY next_run_at NULLS FIRST
$$;

-- Daily budget gate for an external service (true = a call may be made).
CREATE OR REPLACE FUNCTION public.budget_allows(p_service text, p_calls integer DEFAULT 1)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT u.calls FROM api_usage u WHERE u.day = current_date AND u.service = p_service), 0) + p_calls
         <= COALESCE((SELECT b.daily_limit FROM api_budgets b WHERE b.service = p_service), 2147483647)
$$;

-- ─── 2. Observation stores (append-only; one row per distinct content) ──────
CREATE TABLE IF NOT EXISTS public.wx_metar (
  id             bigserial PRIMARY KEY,
  station        text NOT NULL,
  obs_time       timestamptz NOT NULL,
  report_time    timestamptz,
  receipt_time   timestamptz,
  lat            double precision NOT NULL,
  lon            double precision NOT NULL,
  wind_dir_deg   integer,                     -- NULL when variable
  wind_variable  boolean NOT NULL DEFAULT false,
  wind_kt        numeric,
  gust_kt        numeric,
  visibility_sm  numeric,
  visibility_plus boolean NOT NULL DEFAULT false,
  temp_c         numeric,
  dewpoint_c     numeric,
  altimeter_hpa  numeric,
  flight_category text,
  wx_string      text,
  cover          text,
  raw            text NOT NULL,
  quality        text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','rejected')),
  quality_flags  text[] NOT NULL DEFAULT '{}',
  source_id      text NOT NULL REFERENCES public.data_sources(id),
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  content_hash   text NOT NULL,
  UNIQUE (station, obs_time, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_wx_metar_station_time ON public.wx_metar (station, obs_time DESC);
CREATE INDEX IF NOT EXISTS idx_wx_metar_time ON public.wx_metar (obs_time DESC);

CREATE TABLE IF NOT EXISTS public.wx_taf (
  id           bigserial PRIMARY KEY,
  station      text NOT NULL,
  issue_time   timestamptz NOT NULL,
  valid_from   timestamptz NOT NULL,
  valid_to     timestamptz NOT NULL,
  lat          double precision,
  lon          double precision,
  periods      jsonb NOT NULL DEFAULT '[]',
  raw          text NOT NULL,
  quality      text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','rejected')),
  quality_flags text[] NOT NULL DEFAULT '{}',
  source_id    text NOT NULL REFERENCES public.data_sources(id),
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  UNIQUE (station, issue_time, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_wx_taf_station ON public.wx_taf (station, issue_time DESC);

CREATE TABLE IF NOT EXISTS public.wx_advisories (
  id            bigserial PRIMARY KEY,
  source_id     text NOT NULL REFERENCES public.data_sources(id),
  kind          text NOT NULL CHECK (kind IN ('SIGMET','CONVECTIVE_SIGMET','AIRMET','G-AIRMET','NWS_ALERT','OTHER')),
  external_id   text NOT NULL,
  hazard        text,
  severity      text,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL,
  alt_low_ft    integer,
  alt_high_ft   integer,
  geometry_type text NOT NULL DEFAULT 'polygon' CHECK (geometry_type IN ('polygon','line','none')),
  polygon       jsonb,                         -- [{lat,lon}, ...]
  headline      text,
  raw           text,
  quality       text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','rejected')),
  quality_flags text[] NOT NULL DEFAULT '{}',
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  content_hash  text NOT NULL,
  UNIQUE (source_id, external_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_wx_advisories_valid ON public.wx_advisories (valid_to DESC, valid_from);

CREATE TABLE IF NOT EXISTS public.airspace_restrictions (
  id               bigserial PRIMARY KEY,
  source_id        text NOT NULL REFERENCES public.data_sources(id),
  external_id      text NOT NULL,             -- NOTAM number, e.g. 6/7641
  kind             text NOT NULL DEFAULT 'TFR',
  restriction_type text,                       -- SECURITY, HAZARDS, VIP, SPACE OPERATIONS…
  name             text,
  state            text,
  facility         text,
  valid_from       timestamptz,
  valid_to         timestamptz,
  alt_low_ft       integer,
  alt_high_ft      integer,
  areas            jsonb NOT NULL DEFAULT '[]', -- [[{lat,lon},...], ...]
  description      text,
  quality          text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','rejected')),
  quality_flags    text[] NOT NULL DEFAULT '{}',
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  withdrawn_at     timestamptz,
  content_hash     text NOT NULL,
  UNIQUE (source_id, external_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_restrictions_ext ON public.airspace_restrictions (external_id, fetched_at DESC);

-- Latest version of each restriction that is still published.
CREATE OR REPLACE VIEW public.airspace_restrictions_current WITH (security_invoker = true) AS
  SELECT DISTINCT ON (external_id) *
  FROM public.airspace_restrictions
  WHERE withdrawn_at IS NULL AND quality <> 'rejected'
  ORDER BY external_id, fetched_at DESC, id DESC;

-- Mark restrictions that disappeared from the authoritative list as withdrawn.
CREATE OR REPLACE FUNCTION public.withdraw_missing_restrictions(p_source text, p_seen text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  UPDATE airspace_restrictions SET last_seen_at = now()
  WHERE source_id = p_source AND external_id = ANY (p_seen) AND withdrawn_at IS NULL;
  UPDATE airspace_restrictions SET withdrawn_at = now()
  WHERE source_id = p_source AND withdrawn_at IS NULL AND NOT (external_id = ANY (p_seen));
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

CREATE TABLE IF NOT EXISTS public.traffic_observations (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES public.data_sources(id),
  icao24          text NOT NULL,
  callsign        text,
  origin_country  text,
  observed_at     timestamptz NOT NULL,
  lat             double precision NOT NULL,
  lon             double precision NOT NULL,
  baro_alt_m      double precision,
  geo_alt_m       double precision,
  on_ground       boolean NOT NULL DEFAULT false,
  velocity_ms     double precision,
  track_deg       double precision,
  vertical_rate_ms double precision,
  squawk          text,
  category        integer,
  quality         text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','rejected')),
  quality_flags   text[] NOT NULL DEFAULT '{}',
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (icao24, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_traffic_time ON public.traffic_observations (observed_at DESC);

CREATE TABLE IF NOT EXISTS public.wx_forecast_snapshots (
  id            bigserial PRIMARY KEY,
  source_id     text NOT NULL REFERENCES public.data_sources(id),
  purpose       text NOT NULL CHECK (purpose IN ('verification','planning')),
  station       text,
  flight_intent_id uuid,
  lat           double precision NOT NULL,
  lon           double precision NOT NULL,
  valid_at      timestamptz NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  lead_minutes  integer NOT NULL,
  wind_kmh      numeric NOT NULL,
  wind_dir_deg  numeric,
  gust_kmh      numeric NOT NULL,
  precip_mm     numeric,
  temp_c        numeric,
  weather_code  integer,
  visibility_m  numeric,
  content_hash  text NOT NULL,
  UNIQUE (source_id, purpose, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_fcst_snap_valid ON public.wx_forecast_snapshots (purpose, valid_at);

-- Forecast-vs-observation pairs (the cross-reference that drives weather learning).
CREATE TABLE IF NOT EXISTS public.wx_verification (
  id             bigserial PRIMARY KEY,
  snapshot_id    bigint NOT NULL UNIQUE REFERENCES public.wx_forecast_snapshots(id),
  metar_id       bigint NOT NULL REFERENCES public.wx_metar(id),
  station        text NOT NULL,
  valid_at       timestamptz NOT NULL,
  lead_minutes   integer NOT NULL,
  fcst_wind_kmh  numeric NOT NULL,
  obs_wind_kmh   numeric NOT NULL,
  wind_error_kmh numeric NOT NULL,
  fcst_gust_kmh  numeric NOT NULL,
  obs_gust_kmh   numeric NOT NULL,
  gust_error_kmh numeric NOT NULL,
  fcst_temp_c    numeric,
  obs_temp_c     numeric,
  paired_at      timestamptz NOT NULL DEFAULT now()   -- the time this fact became known
);
CREATE INDEX IF NOT EXISTS idx_wx_verif_paired ON public.wx_verification (paired_at);

CREATE OR REPLACE FUNCTION public.pair_forecast_verification(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  INSERT INTO wx_verification (snapshot_id, metar_id, station, valid_at, lead_minutes,
    fcst_wind_kmh, obs_wind_kmh, wind_error_kmh, fcst_gust_kmh, obs_gust_kmh, gust_error_kmh, fcst_temp_c, obs_temp_c)
  SELECT s.id, m.id, s.station, s.valid_at, s.lead_minutes,
         s.wind_kmh, m.wind_kt * 1.852, s.wind_kmh - m.wind_kt * 1.852,
         s.gust_kmh, COALESCE(m.gust_kt, m.wind_kt) * 1.852, s.gust_kmh - COALESCE(m.gust_kt, m.wind_kt) * 1.852,
         s.temp_c, m.temp_c
  FROM (SELECT * FROM wx_forecast_snapshots s0
        WHERE s0.purpose = 'verification' AND s0.station IS NOT NULL
          AND s0.valid_at < now() - interval '15 minutes'
          AND NOT EXISTS (SELECT 1 FROM wx_verification v0 WHERE v0.snapshot_id = s0.id)
        ORDER BY s0.valid_at LIMIT p_limit) s
  CROSS JOIN LATERAL (
    SELECT * FROM wx_metar m0
    WHERE m0.station = s.station AND m0.quality = 'ok' AND m0.wind_kt IS NOT NULL
      AND m0.obs_time BETWEEN s.valid_at - interval '10 minutes' AND s.valid_at + interval '10 minutes'
    ORDER BY abs(extract(epoch FROM m0.obs_time - s.valid_at)), m0.fetched_at DESC
    LIMIT 1) m
  ON CONFLICT (snapshot_id) DO NOTHING;
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

-- Nearest usable METAR to a point at time p_at. Never returns an observation
-- from after p_at (no look-ahead) or older than p_max_age (no stale "current").
CREATE OR REPLACE FUNCTION public.nearest_metar(p_lat double precision, p_lon double precision,
  p_at timestamptz DEFAULT now(), p_max_km double precision DEFAULT 30, p_max_age interval DEFAULT interval '90 minutes')
RETURNS TABLE (id bigint, station text, obs_time timestamptz, distance_km double precision, age_minutes double precision,
               wind_kt numeric, gust_kt numeric, wind_dir_deg integer, visibility_sm numeric, temp_c numeric,
               flight_category text, wx_string text, quality text, raw text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.station, m.obs_time, geo_dist_m(p_lat, p_lon, m.lat, m.lon) / 1000.0,
         extract(epoch FROM p_at - m.obs_time) / 60.0,
         m.wind_kt, m.gust_kt, m.wind_dir_deg, m.visibility_sm, m.temp_c, m.flight_category, m.wx_string, m.quality, m.raw
  FROM wx_metar m
  WHERE m.quality <> 'rejected'
    AND m.obs_time <= p_at AND m.obs_time >= p_at - p_max_age
    AND m.lat BETWEEN p_lat - p_max_km / 111.0 AND p_lat + p_max_km / 111.0
    AND geo_dist_m(p_lat, p_lon, m.lat, m.lon) <= p_max_km * 1000
  ORDER BY geo_dist_m(p_lat, p_lon, m.lat, m.lon) / 1000.0 + extract(epoch FROM p_at - m.obs_time) / 600.0
  LIMIT 1
$$;

-- Same 0..100 thresholds as _shared/weather.ts computeRisk (wind/gust part),
-- plus visibility/flight category — used to classify OBSERVED conditions.
CREATE OR REPLACE FUNCTION public.observed_risk_level(p_wind_kmh numeric, p_gust_kmh numeric, p_vis_sm numeric, p_wx text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s >= 60 THEN 'high' WHEN s >= 30 THEN 'moderate' ELSE 'low' END FROM (
    SELECT LEAST(100,
      CASE WHEN p_wind_kmh > 50 THEN 40 WHEN p_wind_kmh > 35 THEN 25 WHEN p_wind_kmh > 20 THEN 12 WHEN p_wind_kmh > 10 THEN 4 ELSE 0 END +
      CASE WHEN p_gust_kmh > 60 THEN 30 WHEN p_gust_kmh > 40 THEN 18 WHEN p_gust_kmh > 25 THEN 8 ELSE 0 END +
      CASE WHEN p_wx ~ 'TS' THEN 30 WHEN p_wx ~ 'SH' THEN 15 WHEN p_wx ~ '(RA|SN)' THEN 10 WHEN p_wx ~ 'DZ' THEN 6 ELSE 0 END +
      CASE WHEN p_vis_sm IS NOT NULL AND p_vis_sm < 2 THEN 20 WHEN p_vis_sm IS NOT NULL AND p_vis_sm < 4 THEN 8 ELSE 0 END) AS s
  ) x
$$;

-- ─── 3. Telemetry ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.try_timestamptz(p text)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN p::timestamptz; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;

ALTER TABLE public.flight_intents
  ADD COLUMN IF NOT EXISTS telemetry_source  text CHECK (telemetry_source IS NULL OR telemetry_source IN ('gps','sim','none')),
  ADD COLUMN IF NOT EXISTS last_telemetry_at timestamptz,
  ADD COLUMN IF NOT EXISTS telemetry_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_air_at         timestamptz;

CREATE TABLE IF NOT EXISTS public.flight_telemetry (
  id               bigserial PRIMARY KEY,
  flight_intent_id uuid NOT NULL REFERENCES public.flight_intents(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  recorded_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  lat              double precision NOT NULL,
  lon              double precision NOT NULL,
  accuracy_m       double precision,
  speed_ms         double precision,
  heading_deg      double precision,
  altitude_m       double precision,
  quality          text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','rejected')),
  quality_flags    text[] NOT NULL DEFAULT '{}',
  UNIQUE (flight_intent_id, recorded_at)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time ON public.flight_telemetry (flight_intent_id, recorded_at);
ALTER TABLE public.flight_telemetry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own telemetry" ON public.flight_telemetry;
CREATE POLICY "Users read own telemetry" ON public.flight_telemetry FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.flight_telemetry FROM anon, authenticated;

-- Validate + store a batch of GPS fixes for an owned, airborne flight.
-- The flight row is locked so concurrent batches are applied in order.
CREATE OR REPLACE FUNCTION public.ingest_telemetry(p_user uuid, p_intent uuid, p_points jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fi record; v_prev record; v_pt jsonb; v_t timestamptz; v_lat float8; v_lon float8; v_acc float8;
  v_flags text[]; v_quality text; v_ins integer := 0; v_dup integer := 0; v_rej integer := 0; v_n integer;
  v_speed float8; v_last timestamptz;
BEGIN
  SELECT id, status, user_id, created_at INTO v_fi FROM flight_intents
  WHERE id = p_intent AND user_id = p_user FOR UPDATE;
  IF v_fi.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_fi.status NOT IN ('in_air', 'active', 'landed') THEN
    RETURN jsonb_build_object('error', 'not_airborne', 'status', v_fi.status);
  END IF;

  SELECT recorded_at, lat, lon INTO v_prev FROM flight_telemetry
  WHERE flight_intent_id = p_intent AND quality <> 'rejected' ORDER BY recorded_at DESC LIMIT 1;

  FOR v_pt IN SELECT value FROM jsonb_array_elements(p_points) ORDER BY try_timestamptz(value->>'t') NULLS LAST LOOP
    v_flags := '{}'; v_quality := 'ok';
    BEGIN
      v_t := try_timestamptz(v_pt->>'t'); v_lat := (v_pt->>'lat')::float8; v_lon := (v_pt->>'lon')::float8;
      v_acc := NULLIF(v_pt->>'acc', '')::float8;
    EXCEPTION WHEN OTHERS THEN v_rej := v_rej + 1; CONTINUE; END;
    IF v_t IS NULL OR v_lat IS NULL OR v_lon IS NULL OR v_lat NOT BETWEEN -90 AND 90 OR v_lon NOT BETWEEN -180 AND 180 THEN
      v_rej := v_rej + 1; CONTINUE;
    END IF;
    IF v_t > now() + interval '30 seconds' THEN v_flags := v_flags || 'future_timestamp'::text; v_quality := 'rejected'; END IF;
    IF v_t < v_fi.created_at - interval '5 minutes' THEN v_flags := v_flags || 'before_filing'::text; v_quality := 'rejected'; END IF;
    IF v_acc IS NOT NULL AND v_acc > 100 THEN v_flags := v_flags || 'low_accuracy'::text;
      IF v_quality = 'ok' THEN v_quality := 'suspect'; END IF; END IF;
    IF v_quality <> 'rejected' AND v_prev.recorded_at IS NOT NULL AND v_t > v_prev.recorded_at THEN
      v_speed := geo_dist_m(v_prev.lat, v_prev.lon, v_lat, v_lon) / GREATEST(1, extract(epoch FROM v_t - v_prev.recorded_at));
      IF v_speed > 120 THEN v_flags := v_flags || 'implausible_jump'::text; v_quality := 'rejected'; END IF;
    END IF;
    INSERT INTO flight_telemetry (flight_intent_id, user_id, recorded_at, lat, lon, accuracy_m, speed_ms, heading_deg, altitude_m, quality, quality_flags)
    VALUES (p_intent, p_user, v_t, v_lat, v_lon, v_acc,
            NULLIF(v_pt->>'spd', '')::float8, NULLIF(v_pt->>'hdg', '')::float8, NULLIF(v_pt->>'alt', '')::float8, v_quality, v_flags)
    ON CONFLICT (flight_intent_id, recorded_at) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN v_dup := v_dup + 1;
    ELSIF v_quality = 'rejected' THEN v_rej := v_rej + 1;
    ELSE
      v_ins := v_ins + 1;
      IF v_prev.recorded_at IS NULL OR v_t > v_prev.recorded_at THEN
        v_prev.recorded_at := v_t; v_prev.lat := v_lat; v_prev.lon := v_lon;
      END IF;
    END IF;
  END LOOP;

  SELECT max(recorded_at) INTO v_last FROM flight_telemetry WHERE flight_intent_id = p_intent AND quality <> 'rejected';
  UPDATE flight_intents SET telemetry_source = 'gps', last_telemetry_at = v_last,
    telemetry_count = (SELECT count(*) FROM flight_telemetry WHERE flight_intent_id = p_intent AND quality <> 'rejected')
  WHERE id = p_intent;
  RETURN jsonb_build_object('inserted', v_ins, 'duplicates', v_dup, 'rejected', v_rej);
END $$;

-- ─── 4. Model parameters (versioned; planning reads only the active set) ────
CREATE TABLE IF NOT EXISTS public.model_params (
  id             bigserial PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('route_weights','duration_calibration','wind_bias','route_stats')),
  version        integer NOT NULL,
  params         jsonb NOT NULL,
  status         text NOT NULL CHECK (status IN ('candidate','active','rejected','retired')),
  trained_at     timestamptz NOT NULL DEFAULT now(),
  training_as_of timestamptz,
  n_train        integer NOT NULL DEFAULT 0,
  n_holdout      integer NOT NULL DEFAULT 0,
  metrics        jsonb,
  notes          text,
  promoted_at    timestamptz,
  retired_at     timestamptz,
  UNIQUE (kind, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS model_params_one_active ON public.model_params (kind) WHERE status = 'active';
ALTER TABLE public.model_params ENABLE ROW LEVEL SECURITY;

INSERT INTO public.model_params (kind, version, params, status, promoted_at, notes) VALUES
  ('route_weights', 1,
   '{"weight_safety":0.22,"weight_weather":0.18,"weight_traffic":0.15,"weight_efficiency":0.15,"weight_time":0.20,"weight_fuel":0.10}',
   'active', now(), 'Static configured weights. Not learned: there is no observable ground truth for "best route".'),
  ('duration_calibration', 1, '{"factor_by_band":{"low":1,"mid":1,"high":1},"default_factor":1}', 'active', now(),
   'Identity calibration until enough verified GPS flights exist.'),
  ('wind_bias', 1, '{"wind_bias_kmh":0,"gust_bias_kmh":0}', 'active', now(),
   'No correction until enough forecast/METAR verification pairs exist.'),
  ('route_stats', 1, '{"routes":{}}', 'active', now(), 'No verified flights yet.')
ON CONFLICT (kind, version) DO NOTHING;

CREATE OR REPLACE FUNCTION public.active_model_params()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_object_agg(kind, jsonb_build_object('version', version, 'params', params,
           'trained_at', trained_at, 'n_train', n_train)), '{}'::jsonb)
  FROM model_params WHERE status = 'active'
$$;

ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS model_versions jsonb;
ALTER TABLE public.flight_decisions ADD COLUMN IF NOT EXISTS model_versions jsonb;

-- ─── 5. Past flights ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.past_flights (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_intent_id      uuid NOT NULL UNIQUE,
  user_id               uuid,
  aircraft_id           text NOT NULL,
  operator_name         text,
  origin                text NOT NULL,
  destination           text NOT NULL,
  origin_lat            double precision, origin_lon double precision,
  dest_lat              double precision, dest_lon double precision,
  altitude_band         text,
  filed_at              timestamptz,
  planned_departure_start timestamptz,
  planned_departure_end timestamptz,
  final_status          text NOT NULL CHECK (final_status IN
                          ('completed','aborted','diverted','ended_unconfirmed','not_flown','simulated','legacy')),
  verification_status   text NOT NULL CHECK (verification_status IN
                          ('verified','unverified','simulated','legacy_unverified','rejected')),
  verification_notes    text[] NOT NULL DEFAULT '{}',
  telemetry_source      text NOT NULL DEFAULT 'none',
  telemetry_points      integer NOT NULL DEFAULT 0,
  actual_departure_at   timestamptz,
  actual_arrival_at     timestamptz,
  actual_duration_min   numeric,
  max_deviation_m       numeric,
  end_distance_to_dest_m numeric,
  track_summary         jsonb,           -- ≤200 fixes [{t,lat,lon}]
  planned_route         jsonb,           -- primary waypoints
  planned_duration_min  numeric,
  prediction_snapshot   jsonb,           -- scores, decision, forecast used, model versions
  outcome_reported      jsonb,           -- client report (kept verbatim, never trusted for learning)
  weather_observed      jsonb,
  weather_obs_status    text NOT NULL DEFAULT 'pending'
                          CHECK (weather_obs_status IN ('pending','observed','unavailable','not_applicable')),
  analysis              jsonb,
  reconciled_at         timestamptz,
  learning_excluded     boolean NOT NULL DEFAULT false,
  learning_exclusion_reason text,
  archived_at           timestamptz NOT NULL DEFAULT now(),
  available_at          timestamptz NOT NULL DEFAULT now()  -- when this record became knowable (as-of queries)
);
CREATE INDEX IF NOT EXISTS idx_past_flights_user ON public.past_flights (user_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_past_flights_learning ON public.past_flights (verification_status, available_at);
ALTER TABLE public.past_flights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own past flights" ON public.past_flights;
CREATE POLICY "Users read own past flights" ON public.past_flights FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.record_corrections (
  id              bigserial PRIMARY KEY,
  table_name      text NOT NULL,
  record_id       uuid NOT NULL,
  field           text NOT NULL,
  original_value  jsonb,
  corrected_value jsonb,
  reason          text NOT NULL,
  evidence        jsonb NOT NULL,
  actor           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_corrections_record ON public.record_corrections (table_name, record_id);
ALTER TABLE public.record_corrections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.prediction_errors (
  id             bigserial PRIMARY KEY,
  past_flight_id uuid NOT NULL REFERENCES public.past_flights(id),
  kind           text NOT NULL CHECK (kind IN ('duration','wind','gust','weather_risk','calc_consistency')),
  predicted      jsonb,
  observed       jsonb,
  error          numeric,
  verified       boolean NOT NULL,
  detail         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (past_flight_id, kind)
);
ALTER TABLE public.prediction_errors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own prediction errors" ON public.prediction_errors;
CREATE POLICY "Users read own prediction errors" ON public.prediction_errors FOR SELECT TO authenticated
  USING (past_flight_id IN (SELECT id FROM public.past_flights WHERE user_id = auth.uid()));

-- Past flights are append-only. Enrichment columns may be filled in later;
-- everything else changes only inside apply_correction() (which logs the
-- original). Rows are never deleted.
CREATE OR REPLACE FUNCTION public.guard_past_flights()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  enrich text[] := ARRAY['weather_observed','weather_obs_status','analysis','reconciled_at',
                         'learning_excluded','learning_exclusion_reason','verification_notes'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('shnav.allow_past_delete', true), '') <> 'on' THEN
      RAISE EXCEPTION 'past_flights rows are permanent' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - enrich) IS DISTINCT FROM (to_jsonb(OLD) - enrich)
     AND COALESCE(current_setting('shnav.applying_correction', true), '') <> 'on' THEN
    RAISE EXCEPTION 'past_flights core fields change only through apply_correction()' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_past_flights_guard ON public.past_flights;
CREATE TRIGGER trg_past_flights_guard BEFORE UPDATE OR DELETE ON public.past_flights
  FOR EACH ROW EXECUTE FUNCTION public.guard_past_flights();

-- Evidence-backed correction with the original value preserved.
CREATE OR REPLACE FUNCTION public.apply_correction(p_table text, p_id uuid, p_field text, p_value jsonb,
  p_reason text, p_evidence jsonb, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  allowed jsonb := '{
    "past_flights": ["actual_departure_at","actual_arrival_at","actual_duration_min","final_status","verification_status","planned_duration_min"],
    "flight_outcomes": ["actual_duration_minutes","delay_minutes","actual_departure_time","actual_arrival_time","completion_status",
                        "experienced_max_wind_kmh","experienced_max_gusts_kmh","experienced_route_deviation_m","experienced_turbulence_probability"],
    "flight_intents": ["trajectory_score"],
    "routes": ["overall_score","safety_score","weather_score","traffic_score","efficiency_score","weather_conditions"]
  }';
  v_orig jsonb; v_id bigint; v_exists boolean;
BEGIN
  IF NOT (allowed ? p_table) OR NOT (allowed->p_table ? p_field) THEN
    RAISE EXCEPTION 'field %.% is not correctable', p_table, p_field;
  END IF;
  IF p_evidence IS NULL OR p_evidence = '{}'::jsonb OR coalesce(p_reason, '') = '' THEN
    RAISE EXCEPTION 'a correction requires a reason and evidence';
  END IF;
  EXECUTE format('SELECT true, to_jsonb(t)->%L FROM %I t WHERE id = $1 FOR UPDATE', p_field, p_table)
    INTO v_exists, v_orig USING p_id;
  IF v_exists IS NULL THEN RAISE EXCEPTION '%.% not found', p_table, p_id; END IF;
  IF v_orig IS NOT DISTINCT FROM p_value THEN RETURN NULL; END IF;
  INSERT INTO record_corrections (table_name, record_id, field, original_value, corrected_value, reason, evidence, actor)
  VALUES (p_table, p_id, p_field, v_orig, p_value, p_reason, p_evidence, p_actor) RETURNING id INTO v_id;
  PERFORM set_config('shnav.applying_correction', 'on', true);
  EXECUTE format('UPDATE %I SET %I = (jsonb_populate_record(NULL::%I, jsonb_build_object(%L, $1))).%I WHERE id = $2',
                 p_table, p_field, p_table, p_field, p_field) USING p_value, p_id;
  PERFORM set_config('shnav.applying_correction', 'off', true);
  RETURN v_id;
END $$;

-- The old trigger copied landed flights into historical_flights and rewrote
-- the status to "archived" immediately — before the end of the flight was
-- confirmed. It now only stamps times; finalize_flight() does the move.
CREATE OR REPLACE FUNCTION public.archive_landed_flight()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'in_air' AND NEW.in_air_at IS NULL THEN NEW.in_air_at := now(); END IF;
    IF NEW.status = 'landed' AND NEW.landed_at IS NULL THEN NEW.landed_at := now(); END IF;
    IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN NEW.archived_at := now(); END IF;
  END IF;
  RETURN NEW;
END $$;

-- Move one ended flight from the active store into past_flights.
CREATE OR REPLACE FUNCTION public.finalize_flight(p_intent uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  fi record; rt record; dec record; oc record;
  v_n integer; v_first record; v_last record; v_dep timestamptz; v_arr timestamptz;
  v_route jsonb; v_maxdev numeric; v_end_dist numeric; v_final text; v_verif text; v_notes text[] := '{}';
  v_track jsonb; v_planned numeric; v_dur numeric; v_pf uuid; v_src text;
BEGIN
  SELECT * INTO fi FROM flight_intents WHERE id = p_intent FOR UPDATE SKIP LOCKED;
  IF fi.id IS NULL THEN RETURN jsonb_build_object('skipped', 'locked_or_missing'); END IF;
  IF EXISTS (SELECT 1 FROM past_flights WHERE flight_intent_id = p_intent) THEN
    UPDATE flight_intents SET status = 'archived' WHERE id = p_intent AND status <> 'archived';
    RETURN jsonb_build_object('skipped', 'already_past');
  END IF;
  IF NOT p_force AND fi.status NOT IN ('landed', 'expired', 'in_air', 'active', 'archived') THEN
    RETURN jsonb_build_object('skipped', 'not_ended', 'status', fi.status);
  END IF;

  SELECT * INTO rt FROM routes WHERE flight_intent_id = p_intent ORDER BY created_at DESC LIMIT 1;
  SELECT * INTO dec FROM flight_decisions WHERE flight_intent_id = p_intent AND NOT superseded ORDER BY created_at DESC LIMIT 1;
  SELECT * INTO oc FROM flight_outcomes WHERE flight_intent_id = p_intent;
  v_route := rt.primary_route->'waypoints';
  v_planned := NULLIF(rt.primary_route->>'estimated_time_min', '')::numeric;

  SELECT count(*) INTO v_n FROM flight_telemetry WHERE flight_intent_id = p_intent AND quality <> 'rejected';
  v_src := CASE WHEN v_n > 0 THEN 'gps' ELSE COALESCE(fi.telemetry_source, 'none') END;

  IF v_n > 0 THEN
    SELECT recorded_at, lat, lon INTO v_first FROM flight_telemetry
      WHERE flight_intent_id = p_intent AND quality <> 'rejected' ORDER BY recorded_at LIMIT 1;
    SELECT recorded_at, lat, lon INTO v_last FROM flight_telemetry
      WHERE flight_intent_id = p_intent AND quality <> 'rejected' ORDER BY recorded_at DESC LIMIT 1;
    -- Departure = first fix >300 m from the filed origin (else the first fix).
    SELECT min(recorded_at) INTO v_dep FROM flight_telemetry
      WHERE flight_intent_id = p_intent AND quality <> 'rejected' AND fi.origin_lat IS NOT NULL
        AND geo_dist_m(fi.origin_lat, fi.origin_lon, lat, lon) > 300;
    v_dep := COALESCE(v_dep, v_first.recorded_at);
    -- Arrival = first fix within 400 m of the filed destination after departure.
    SELECT min(recorded_at) INTO v_arr FROM flight_telemetry
      WHERE flight_intent_id = p_intent AND quality <> 'rejected' AND fi.dest_lat IS NOT NULL
        AND recorded_at >= v_dep AND geo_dist_m(fi.dest_lat, fi.dest_lon, lat, lon) <= 400;
    IF fi.dest_lat IS NOT NULL THEN
      v_end_dist := round(geo_dist_m(fi.dest_lat, fi.dest_lon, v_last.lat, v_last.lon)::numeric, 1);
    END IF;
    IF v_route IS NOT NULL AND jsonb_array_length(v_route) > 0 THEN
      SELECT round(max(dist_to_polyline_m(lat, lon, v_route))::numeric, 1) INTO v_maxdev
      FROM flight_telemetry WHERE flight_intent_id = p_intent AND quality <> 'rejected';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('t', recorded_at, 'lat', round(lat::numeric, 6), 'lon', round(lon::numeric, 6)) ORDER BY recorded_at)
      INTO v_track
    FROM (SELECT recorded_at, lat, lon, row_number() OVER (ORDER BY recorded_at) rn
          FROM flight_telemetry WHERE flight_intent_id = p_intent AND quality <> 'rejected') x
    WHERE (rn - 1) % GREATEST(1, ceil(v_n / 200.0)::int) = 0 OR rn = v_n;
    IF v_arr IS NOT NULL THEN v_dur := round((extract(epoch FROM v_arr - v_dep) / 60.0)::numeric, 2); END IF;
  END IF;

  -- Final status + verification, with reasons recorded.
  IF v_n = 0 THEN
    IF fi.landed_at IS NOT NULL OR fi.status = 'landed' OR oc.id IS NOT NULL THEN
      v_final := 'simulated'; v_verif := 'simulated';
      v_notes := v_notes || 'no GPS telemetry received: flight was simulated or tracked offline'::text;
    ELSIF fi.in_air_at IS NOT NULL OR fi.status IN ('in_air', 'active') THEN
      v_final := 'ended_unconfirmed'; v_verif := 'unverified';
      v_notes := v_notes || 'took off but no telemetry and no landing report'::text;
    ELSE
      v_final := 'not_flown'; v_verif := 'unverified';
      v_notes := v_notes || ('never departed (status ' || fi.status || ')');
    END IF;
  ELSE
    IF v_arr IS NOT NULL THEN
      v_final := CASE WHEN oc.completion_status IN ('aborted', 'diverted') THEN oc.completion_status ELSE 'completed' END;
    ELSIF oc.completion_status IN ('aborted', 'diverted') THEN
      v_final := oc.completion_status;
    ELSE
      v_final := 'ended_unconfirmed';
      v_notes := v_notes || format('telemetry ended %s m from destination', COALESCE(v_end_dist::text, '?'));
    END IF;
    v_verif := 'verified';
    IF v_final <> 'completed' THEN v_verif := 'unverified'; END IF;
    IF v_n < 10 THEN v_verif := 'unverified'; v_notes := v_notes || format('only %s GPS fixes (<10)', v_n); END IF;
    IF fi.coords_status IS DISTINCT FROM 'resolved' THEN v_verif := 'unverified'; v_notes := v_notes || 'origin/destination not fully resolved'::text; END IF;
    IF v_dur IS NOT NULL AND (v_dur < 1 OR v_dur > 600) THEN
      v_verif := 'rejected'; v_notes := v_notes || format('implausible duration %s min', v_dur);
    END IF;
  END IF;

  INSERT INTO past_flights (flight_intent_id, user_id, aircraft_id, operator_name, origin, destination,
    origin_lat, origin_lon, dest_lat, dest_lon, altitude_band, filed_at, planned_departure_start, planned_departure_end,
    final_status, verification_status, verification_notes, telemetry_source, telemetry_points,
    actual_departure_at, actual_arrival_at, actual_duration_min, max_deviation_m, end_distance_to_dest_m, track_summary,
    planned_route, planned_duration_min, prediction_snapshot, outcome_reported, weather_obs_status)
  VALUES (fi.id, fi.user_id, fi.aircraft_id, fi.operator_name, fi.origin, fi.destination,
    fi.origin_lat, fi.origin_lon, fi.dest_lat, fi.dest_lon, fi.altitude_band, fi.created_at,
    fi.departure_start_at, fi.departure_end_at,
    v_final, v_verif, v_notes, v_src, v_n,
    CASE WHEN v_n > 0 THEN v_dep END, v_arr, v_dur, v_maxdev, v_end_dist, v_track,
    v_route, v_planned,
    jsonb_strip_nulls(jsonb_build_object(
      'route_id', rt.id, 'route_candidate', rt.primary_route->>'id',
      'overall_score', rt.overall_score, 'safety_score', rt.safety_score, 'weather_score', rt.weather_score,
      'traffic_score', rt.traffic_score, 'efficiency_score', rt.efficiency_score,
      'weather_risk', rt.weather_risk, 'forecast', rt.weather_conditions,
      'estimated_time_min', v_planned, 'raw_estimated_time_min', rt.primary_route->'raw_estimated_time_min',
      'conflicts', fi.conflicts, 'trajectory_score', fi.trajectory_score,
      'decision', dec.decision, 'decision_confidence', dec.confidence, 'decision_departure_time', dec.departure_time,
      'model_versions', COALESCE(dec.model_versions, rt.model_versions))),
    CASE WHEN oc.id IS NOT NULL THEN to_jsonb(oc) - 'flight_intent_id' END,
    CASE WHEN v_final IN ('not_flown', 'simulated') THEN 'not_applicable' ELSE 'pending' END)
  ON CONFLICT (flight_intent_id) DO NOTHING
  RETURNING id INTO v_pf;

  UPDATE flight_intents SET status = 'archived' WHERE id = p_intent;
  UPDATE time_slots SET status = CASE WHEN v_final = 'not_flown' THEN 'cancelled' ELSE 'completed' END
    WHERE flight_intent_id = p_intent AND status IN ('allocated', 'active');
  UPDATE vertiport_slots SET status = CASE WHEN v_final = 'not_flown' THEN 'cancelled' ELSE 'completed' END
    WHERE flight_intent_id = p_intent AND status IN ('scheduled', 'active', 'delayed');

  RETURN jsonb_build_object('past_flight_id', v_pf, 'final_status', v_final, 'verification_status', v_verif,
    'telemetry_points', v_n, 'notes', to_jsonb(v_notes));
END $$;

-- Flights whose end is confirmed (landing reported, ≥2 min settle for the GPS
-- tail), expired, or silent for 45 min after their window → past_flights.
CREATE OR REPLACE FUNCTION public.finalize_ended_flights(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v jsonb; v_done integer := 0; v_skipped integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM flight_intents
    WHERE (status = 'landed' AND COALESCE(landed_at, now()) < now() - interval '2 minutes')
       OR status = 'expired'
       OR (status = 'archived' AND NOT EXISTS (SELECT 1 FROM past_flights p WHERE p.flight_intent_id = flight_intents.id))
       OR (status IN ('in_air', 'active')
           AND GREATEST(COALESCE(last_telemetry_at, in_air_at, departure_end_at, created_at),
                        COALESCE(departure_end_at, created_at)) < now() - interval '45 minutes')
    ORDER BY created_at
    LIMIT p_limit
  LOOP
    v := finalize_flight(r.id);
    IF v ? 'past_flight_id' THEN v_done := v_done + 1; ELSE v_skipped := v_skipped + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('finalized', v_done, 'skipped', v_skipped);
END $$;

-- The landing report is now just a report: it is stored verbatim, the flight
-- is marked landed, and NOTHING is learned from it here. Learning happens in
-- the nightly cycle from verified past flights only.
CREATE OR REPLACE FUNCTION public.record_flight_outcome_tx(p_user uuid, p_intent uuid, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_intent record; v_outcome_id uuid; v_existing record;
  v_arrival timestamptz := COALESCE((p->>'actual_arrival_time')::timestamptz, now());
BEGIN
  SELECT id, status INTO v_intent FROM flight_intents WHERE id = p_intent AND user_id = p_user FOR UPDATE;
  IF v_intent.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  INSERT INTO flight_outcomes (
    flight_intent_id, aircraft_id, route_id, decision_id,
    planned_departure_time, actual_departure_time, planned_arrival_time, actual_arrival_time,
    planned_duration_minutes, actual_duration_minutes, delay_minutes,
    predicted_overall_score, predicted_weather_risk,
    experienced_max_wind_kmh, experienced_max_gusts_kmh, experienced_turbulence_probability,
    experienced_route_deviation_m, reroute_count, decision_accuracy, issues_encountered, completion_status, completed_at)
  VALUES (
    p_intent, COALESCE(p->>'aircraft_id', 'UNKNOWN'),
    (SELECT id FROM routes WHERE id::text = p->>'route_id'),
    (SELECT id FROM flight_decisions WHERE id::text = p->>'decision_id'),
    (p->>'planned_departure_time')::timestamptz, (p->>'actual_departure_time')::timestamptz,
    (p->>'planned_arrival_time')::timestamptz, v_arrival,
    (p->>'planned_duration_minutes')::numeric, COALESCE((p->>'actual_duration_minutes')::numeric, 0),
    COALESCE((p->>'delay_minutes')::numeric, 0),
    (p->>'predicted_overall_score')::numeric, p->>'predicted_weather_risk',
    -- Missing measurements stay NULL (previously coerced to 0 = "calm, on track").
    (p->>'experienced_max_wind_kmh')::numeric, (p->>'experienced_max_gusts_kmh')::numeric,
    (p->>'experienced_turbulence_probability')::numeric, (p->>'experienced_route_deviation_m')::numeric,
    COALESCE((p->>'reroute_count')::integer, 0), NULL,
    CASE WHEN jsonb_typeof(p->'issues_encountered') = 'array' THEN p->'issues_encountered' ELSE '[]'::jsonb END,
    COALESCE(p->>'completion_status', 'completed'), now())
  ON CONFLICT (flight_intent_id) DO NOTHING
  RETURNING id INTO v_outcome_id;

  IF v_outcome_id IS NULL THEN
    SELECT id INTO v_existing FROM flight_outcomes WHERE flight_intent_id = p_intent;
    RETURN jsonb_build_object('outcome_id', v_existing.id, 'already_recorded', true);
  END IF;

  UPDATE flight_intents SET status = 'landed', landed_at = COALESCE(landed_at, v_arrival)
  WHERE id = p_intent AND status IN ('in_air', 'active', 'approved', 'pending', 'landed');

  RETURN jsonb_build_object('outcome_id', v_outcome_id, 'recorded_at', now(),
    'learning', 'pending_verification',
    'note', 'Outcome stored as reported. It is verified against telemetry and observed weather before any learning.');
END $$;

-- Planning statistics only (no self-modifying weights any more).
CREATE OR REPLACE FUNCTION public.refresh_fleet_route_patterns()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_groups integer; v_routes integer;
BEGIN
  WITH src AS (
    SELECT od_key(origin) AS ok, od_key(destination) AS dk, altitude_band AS band,
           overall_score, safety_score, weather_score, traffic_score, efficiency_score,
           primary_route->'waypoints' AS wps, created_at
    FROM routes
    WHERE created_at >= now() - interval '30 days' AND status = 'active' AND altitude_band IS NOT NULL
  ), agg AS (
    SELECT ok, dk, band, count(*) AS n,
      avg(overall_score) AS o, avg(safety_score) AS s, avg(weather_score) AS w,
      avg(traffic_score) AS t, avg(efficiency_score) AS e,
      (array_agg(wps ORDER BY created_at DESC) FILTER (WHERE wps IS NOT NULL))[1] AS wps
    FROM src GROUP BY ok, dk, band
  ), up AS (
    INSERT INTO route_patterns AS rp (origin_key, destination_key, altitude_band, user_id, flight_count,
      avg_overall_score, avg_safety_score, avg_weather_score, avg_traffic_score, avg_efficiency_score,
      preferred_waypoints, last_updated)
    SELECT ok, dk, band, NULL, n, o, s, w, t, e, wps, now() FROM agg
    ON CONFLICT (origin_key, destination_key, altitude_band) WHERE user_id IS NULL DO UPDATE SET
      avg_overall_score = EXCLUDED.avg_overall_score, avg_safety_score = EXCLUDED.avg_safety_score,
      avg_weather_score = EXCLUDED.avg_weather_score, avg_traffic_score = EXCLUDED.avg_traffic_score,
      avg_efficiency_score = EXCLUDED.avg_efficiency_score,
      preferred_waypoints = COALESCE(EXCLUDED.preferred_waypoints, rp.preferred_waypoints),
      last_updated = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_groups FROM up;
  SELECT count(*) INTO v_routes FROM routes WHERE created_at >= now() - interval '30 days' AND status = 'active';
  RETURN jsonb_build_object('processed_routes', v_routes, 'updated_patterns', v_groups, 'timestamp', now());
END $$;

-- ─── 6. Reconciliation: predicted vs observed, evidence-based corrections ───
CREATE OR REPLACE FUNCTION public.reconcile_past_flight(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pf past_flights; m_o record; m_d record; v_obs jsonb; v_status text; v_an jsonb := '{}'::jsonb;
  v_fc jsonb; v_fw numeric; v_ow numeric; v_fg numeric; v_og numeric; v_pr text; v_or text;
  v_dist numeric; v_exp numeric; oc record; v_rep numeric; v_corr bigint; v_excl boolean; v_reason text;
BEGIN
  SELECT * INTO pf FROM past_flights WHERE id = p_id FOR UPDATE SKIP LOCKED;
  IF pf.id IS NULL THEN RETURN jsonb_build_object('skipped', 'locked'); END IF;
  v_excl := pf.learning_excluded; v_reason := pf.learning_exclusion_reason;
  SELECT * INTO m_o FROM nearest_metar(0, 0, now(), 0, interval '0');   -- typed, all-NULL
  SELECT * INTO m_d FROM nearest_metar(0, 0, now(), 0, interval '0');

  IF pf.final_status IN ('not_flown', 'simulated', 'legacy') THEN
    UPDATE past_flights SET reconciled_at = now(),
      weather_obs_status = CASE WHEN weather_obs_status = 'pending' THEN 'not_applicable' ELSE weather_obs_status END,
      analysis = jsonb_build_object('skipped', 'no measured flight to compare')
    WHERE id = p_id;
    RETURN jsonb_build_object('skipped', pf.final_status);
  END IF;

  -- 6a. Observed weather at departure (origin) and arrival (destination).
  IF pf.actual_departure_at IS NOT NULL AND pf.origin_lat IS NOT NULL THEN
    SELECT * INTO m_o FROM nearest_metar(pf.origin_lat, pf.origin_lon, pf.actual_departure_at + interval '10 minutes', 35, interval '75 minutes');
  END IF;
  IF COALESCE(pf.actual_arrival_at, pf.actual_departure_at) IS NOT NULL AND pf.dest_lat IS NOT NULL THEN
    SELECT * INTO m_d FROM nearest_metar(pf.dest_lat, pf.dest_lon, COALESCE(pf.actual_arrival_at, pf.actual_departure_at) + interval '10 minutes', 35, interval '75 minutes');
  END IF;
  IF m_o.id IS NOT NULL OR m_d.id IS NOT NULL THEN
    v_status := 'observed';
    v_obs := jsonb_strip_nulls(jsonb_build_object(
      'departure', CASE WHEN m_o.id IS NOT NULL THEN jsonb_build_object('metar_id', m_o.id, 'station', m_o.station,
        'obs_time', m_o.obs_time, 'distance_km', round(m_o.distance_km::numeric, 1), 'wind_kmh', round(m_o.wind_kt * 1.852, 1),
        'gust_kmh', round(COALESCE(m_o.gust_kt, m_o.wind_kt) * 1.852, 1), 'visibility_sm', m_o.visibility_sm,
        'flight_category', m_o.flight_category, 'wx', m_o.wx_string, 'quality', m_o.quality, 'raw', m_o.raw) END,
      'arrival', CASE WHEN m_d.id IS NOT NULL THEN jsonb_build_object('metar_id', m_d.id, 'station', m_d.station,
        'obs_time', m_d.obs_time, 'distance_km', round(m_d.distance_km::numeric, 1), 'wind_kmh', round(m_d.wind_kt * 1.852, 1),
        'gust_kmh', round(COALESCE(m_d.gust_kt, m_d.wind_kt) * 1.852, 1), 'visibility_sm', m_d.visibility_sm,
        'flight_category', m_d.flight_category, 'wx', m_d.wx_string, 'quality', m_d.quality, 'raw', m_d.raw) END));
  ELSIF COALESCE(pf.actual_arrival_at, pf.archived_at) < now() - interval '6 hours' THEN
    v_status := 'unavailable';
  ELSE
    v_status := 'pending';
  END IF;

  -- 6b. Prediction errors.
  IF pf.planned_duration_min IS NOT NULL AND pf.actual_duration_min IS NOT NULL THEN
    INSERT INTO prediction_errors (past_flight_id, kind, predicted, observed, error, verified, detail)
    VALUES (pf.id, 'duration', to_jsonb(pf.planned_duration_min), to_jsonb(pf.actual_duration_min),
            pf.actual_duration_min - pf.planned_duration_min, pf.verification_status = 'verified',
            'minutes, GPS-measured departure→arrival vs planned estimate')
    ON CONFLICT (past_flight_id, kind) DO NOTHING;
    v_an := v_an || jsonb_build_object('duration_error_min', round(pf.actual_duration_min - pf.planned_duration_min, 2));
  END IF;

  v_fc := pf.prediction_snapshot->'forecast';
  IF m_o.id IS NOT NULL AND v_fc ? 'wind_speed' THEN
    v_fw := (v_fc->>'wind_speed')::numeric; v_ow := round(m_o.wind_kt * 1.852, 1);
    v_fg := (v_fc->>'wind_gusts')::numeric; v_og := round(COALESCE(m_o.gust_kt, m_o.wind_kt) * 1.852, 1);
    INSERT INTO prediction_errors (past_flight_id, kind, predicted, observed, error, verified, detail)
    VALUES (pf.id, 'wind', to_jsonb(v_fw), to_jsonb(v_ow), v_fw - v_ow, m_o.quality = 'ok',
            format('km/h, forecast valid %s vs METAR %s %s', v_fc->>'valid_at', m_o.station, m_o.obs_time))
    ON CONFLICT (past_flight_id, kind) DO NOTHING;
    IF v_fg IS NOT NULL THEN
      INSERT INTO prediction_errors (past_flight_id, kind, predicted, observed, error, verified, detail)
      VALUES (pf.id, 'gust', to_jsonb(v_fg), to_jsonb(v_og), v_fg - v_og, m_o.quality = 'ok', 'km/h; METAR without gust group counts as sustained wind')
      ON CONFLICT (past_flight_id, kind) DO NOTHING;
    END IF;
    v_pr := pf.prediction_snapshot->>'weather_risk';
    v_or := observed_risk_level(v_ow, v_og, m_o.visibility_sm, COALESCE(m_o.wx_string, ''));
    IF v_pr IN ('low', 'moderate', 'high') THEN
      INSERT INTO prediction_errors (past_flight_id, kind, predicted, observed, error, verified, detail)
      VALUES (pf.id, 'weather_risk', to_jsonb(v_pr), to_jsonb(v_or),
              (array_position(ARRAY['low','moderate','high'], v_pr) - array_position(ARRAY['low','moderate','high'], v_or)),
              m_o.quality = 'ok', 'risk level steps: predicted − observed')
      ON CONFLICT (past_flight_id, kind) DO NOTHING;
    END IF;
    v_an := v_an || jsonb_build_object('wind_error_kmh', v_fw - v_ow, 'predicted_risk', v_pr, 'observed_risk', v_or);
  END IF;

  -- 6c. Calculation consistency: planned duration vs planned route length at cruise speed.
  IF pf.planned_route IS NOT NULL AND jsonb_array_length(pf.planned_route) >= 2 AND pf.planned_duration_min IS NOT NULL THEN
    SELECT sum(geo_dist_m((a->>'lat')::float8, (a->>'lon')::float8, (b->>'lat')::float8, (b->>'lon')::float8)) / 1000.0
      INTO v_dist
    FROM jsonb_array_elements(pf.planned_route) WITH ORDINALITY x(a, i)
    JOIN jsonb_array_elements(pf.planned_route) WITH ORDINALITY y(b, j) ON j = i + 1;
    v_exp := v_dist / 90.0 * 60.0;  -- EVTOL_BASE_SPEED_KMH
    IF v_exp > 0 AND abs(pf.planned_duration_min - v_exp) / v_exp > 0.5 THEN
      INSERT INTO prediction_errors (past_flight_id, kind, predicted, observed, error, verified, detail)
      VALUES (pf.id, 'calc_consistency', to_jsonb(pf.planned_duration_min), to_jsonb(round(v_exp, 2)),
              pf.planned_duration_min - v_exp, true,
              format('planned estimate differs >50%% from route length %s km at 90 km/h', round(v_dist, 2)))
      ON CONFLICT (past_flight_id, kind) DO NOTHING;
      v_an := v_an || jsonb_build_object('calc_inconsistent', true);
    END IF;
  END IF;

  -- 6d. Self-correction: the client-reported duration disagrees with the
  --     GPS measurement → correct the outcome record, keep the original.
  SELECT * INTO oc FROM flight_outcomes WHERE flight_intent_id = pf.flight_intent_id;
  IF oc.id IS NOT NULL AND pf.verification_status = 'verified' AND pf.actual_duration_min IS NOT NULL THEN
    v_rep := oc.actual_duration_minutes;
    IF v_rep IS NULL OR abs(v_rep - pf.actual_duration_min) > 2 THEN
      v_corr := apply_correction('flight_outcomes', oc.id, 'actual_duration_minutes', to_jsonb(pf.actual_duration_min),
        'client-reported duration disagrees with GPS-measured duration',
        jsonb_build_object('telemetry_points', pf.telemetry_points, 'actual_departure_at', pf.actual_departure_at,
                           'actual_arrival_at', pf.actual_arrival_at, 'reported', v_rep),
        'system:reconcile');
      v_an := v_an || jsonb_build_object('corrected_reported_duration', v_corr IS NOT NULL);
    END IF;
  END IF;

  -- 6e. Records that must never train anything.
  IF pf.actual_arrival_at IS NOT NULL AND pf.actual_departure_at IS NOT NULL AND pf.actual_arrival_at <= pf.actual_departure_at THEN
    v_excl := true; v_reason := 'arrival not after departure';
  ELSIF pf.max_deviation_m IS NOT NULL AND pf.max_deviation_m > 20000 THEN
    v_excl := true; v_reason := 'track deviates >20 km from the planned route (likely not this flight)';
  END IF;

  UPDATE past_flights SET weather_observed = COALESCE(v_obs, weather_observed), weather_obs_status = v_status,
    analysis = COALESCE(analysis, '{}'::jsonb) || v_an || jsonb_build_object('reconciled_version', 1),
    reconciled_at = CASE WHEN v_status = 'pending' THEN NULL ELSE now() END,
    learning_excluded = v_excl, learning_exclusion_reason = v_reason
  WHERE id = p_id;
  RETURN jsonb_build_object('weather_obs_status', v_status, 'analysis', v_an);
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_past_flights(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN SELECT id FROM past_flights WHERE reconciled_at IS NULL ORDER BY archived_at LIMIT p_limit LOOP
    PERFORM reconcile_past_flight(r.id); v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('processed', v_n);
END $$;

-- ─── 7. Training (as-of, time-ordered holdout, promotion gate) ──────────────
-- Only data that was KNOWN at p_as_of is used: available_at / paired_at ≤ as_of.
CREATE OR REPLACE FUNCTION public.training_flights(p_as_of timestamptz)
RETURNS SETOF past_flights LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM past_flights
  WHERE verification_status = 'verified' AND final_status = 'completed' AND NOT learning_excluded
    AND available_at <= p_as_of AND actual_arrival_at <= p_as_of
    AND planned_duration_min > 0 AND actual_duration_min > 0
$$;

CREATE OR REPLACE FUNCTION public.promote_or_reject(p_kind text, p_params jsonb, p_as_of timestamptz,
  p_ntrain integer, p_nhold integer, p_metrics jsonb, p_better boolean, p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ver integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('model_params:' || p_kind));
  SELECT COALESCE(max(version), 0) + 1 INTO v_ver FROM model_params WHERE kind = p_kind;
  IF p_better THEN
    UPDATE model_params SET status = 'retired', retired_at = now() WHERE kind = p_kind AND status = 'active';
  END IF;
  INSERT INTO model_params (kind, version, params, status, training_as_of, n_train, n_holdout, metrics, notes, promoted_at)
  VALUES (p_kind, v_ver, p_params, CASE WHEN p_better THEN 'active' ELSE 'rejected' END, p_as_of,
          p_ntrain, p_nhold, p_metrics, p_notes, CASE WHEN p_better THEN now() END);
  RETURN jsonb_build_object('kind', p_kind, 'version', v_ver, 'status', CASE WHEN p_better THEN 'active' ELSE 'rejected' END,
                            'metrics', p_metrics);
END $$;

CREATE OR REPLACE FUNCTION public.train_duration_calibration(p_as_of timestamptz DEFAULT now(), p_min_samples integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer; v_hold integer; v_cut timestamptz; v_params jsonb; v_active jsonb;
  v_mae_new numeric; v_mae_old numeric; v_def numeric;
BEGIN
  SELECT count(*) INTO v_n FROM training_flights(p_as_of);
  IF v_n < p_min_samples THEN
    RETURN jsonb_build_object('kind', 'duration_calibration', 'status', 'insufficient_data', 'n', v_n, 'needed', p_min_samples);
  END IF;
  v_hold := GREATEST(2, floor(v_n * 0.2)::int);
  -- Newest v_hold flights are the holdout (time-ordered — no future → past leakage).
  SELECT actual_arrival_at INTO v_cut FROM training_flights(p_as_of) ORDER BY actual_arrival_at DESC OFFSET v_hold - 1 LIMIT 1;

  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_duration_min / planned_duration_min) INTO v_def
  FROM training_flights(p_as_of) WHERE actual_arrival_at < v_cut;
  v_def := GREATEST(0.7, LEAST(1.5, COALESCE(v_def, 1)));
  SELECT jsonb_build_object('default_factor', round(v_def, 4), 'factor_by_band', COALESCE(jsonb_object_agg(band, round(f::numeric, 4)), '{}'::jsonb))
    INTO v_params
  FROM (SELECT COALESCE(altitude_band, 'low') band,
               GREATEST(0.7, LEAST(1.5, percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_duration_min / planned_duration_min))) f
        FROM training_flights(p_as_of) WHERE actual_arrival_at < v_cut
        GROUP BY 1 HAVING count(*) >= 5) b;

  SELECT params INTO v_active FROM model_params WHERE kind = 'duration_calibration' AND status = 'active';
  -- planned_duration_min was produced under the factor active at planning time;
  -- compare candidate vs active on the raw estimate when it was recorded.
  SELECT avg(abs(raw * COALESCE((v_params->'factor_by_band'->>band)::numeric, (v_params->>'default_factor')::numeric) - actual)),
         avg(abs(raw * COALESCE((v_active->'factor_by_band'->>band)::numeric, (v_active->>'default_factor')::numeric, 1) - actual))
    INTO v_mae_new, v_mae_old
  FROM (SELECT COALESCE(altitude_band, 'low') band, actual_duration_min actual,
               COALESCE(NULLIF(prediction_snapshot->>'raw_estimated_time_min', '')::numeric, planned_duration_min) raw
        FROM training_flights(p_as_of) WHERE actual_arrival_at >= v_cut) h;

  RETURN promote_or_reject('duration_calibration', v_params, p_as_of, v_n - v_hold, v_hold,
    jsonb_build_object('holdout_mae_min', round(v_mae_new, 3), 'active_holdout_mae_min', round(v_mae_old, 3)),
    v_mae_new < v_mae_old * 0.98,
    format('median actual/planned ratio from %s verified GPS flights; promoted only if holdout MAE improves ≥2%%', v_n - v_hold));
END $$;

CREATE OR REPLACE FUNCTION public.train_wind_bias(p_as_of timestamptz DEFAULT now(), p_min_samples integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer; v_hold integer; v_cut timestamptz; v_wb numeric; v_gb numeric; v_active jsonb;
  v_new numeric; v_old numeric;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _wv ON COMMIT DROP AS SELECT * FROM wx_verification LIMIT 0;
  TRUNCATE _wv;
  INSERT INTO _wv SELECT * FROM wx_verification
    WHERE paired_at <= p_as_of AND valid_at >= p_as_of - interval '30 days' AND valid_at <= p_as_of
      AND lead_minutes BETWEEN 15 AND 240;
  SELECT count(*) INTO v_n FROM _wv;
  IF v_n < p_min_samples THEN
    RETURN jsonb_build_object('kind', 'wind_bias', 'status', 'insufficient_data', 'n', v_n, 'needed', p_min_samples);
  END IF;
  v_hold := GREATEST(5, floor(v_n * 0.2)::int);
  SELECT valid_at INTO v_cut FROM _wv ORDER BY valid_at DESC OFFSET v_hold - 1 LIMIT 1;
  SELECT GREATEST(-15, LEAST(15, percentile_cont(0.5) WITHIN GROUP (ORDER BY wind_error_kmh))),
         GREATEST(-15, LEAST(15, percentile_cont(0.5) WITHIN GROUP (ORDER BY gust_error_kmh)))
    INTO v_wb, v_gb FROM _wv WHERE valid_at < v_cut;
  SELECT params INTO v_active FROM model_params WHERE kind = 'wind_bias' AND status = 'active';
  SELECT avg(abs(fcst_wind_kmh - v_wb - obs_wind_kmh)),
         avg(abs(fcst_wind_kmh - COALESCE((v_active->>'wind_bias_kmh')::numeric, 0) - obs_wind_kmh))
    INTO v_new, v_old FROM _wv WHERE valid_at >= v_cut;
  RETURN promote_or_reject('wind_bias',
    jsonb_build_object('wind_bias_kmh', round(v_wb, 2), 'gust_bias_kmh', round(v_gb, 2),
                       'stations', (SELECT jsonb_agg(DISTINCT station) FROM _wv)),
    p_as_of, v_n - v_hold, v_hold,
    jsonb_build_object('holdout_wind_mae_kmh', round(v_new, 3), 'active_holdout_wind_mae_kmh', round(v_old, 3)),
    v_new < v_old * 0.98,
    'median Open-Meteo minus METAR wind error (last 30 days, lead 15–240 min); promoted only if holdout MAE improves ≥2%');
END $$;

-- Descriptive per-route statistics from verified flights (versioned snapshot).
CREATE OR REPLACE FUNCTION public.train_route_stats(p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_params jsonb; v_n integer;
BEGIN
  SELECT count(*), jsonb_build_object('routes', COALESCE(jsonb_object_agg(k, s), '{}'::jsonb))
    INTO v_n, v_params
  FROM (SELECT od_key(origin) || '|' || od_key(destination) || '|' || COALESCE(altitude_band, 'low') k,
               jsonb_build_object('verified_flights', count(*),
                 'median_duration_min', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_duration_min)::numeric, 1),
                 'median_deviation_m', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY max_deviation_m)::numeric, 0),
                 'last_flight_at', max(actual_arrival_at)) s
        FROM training_flights(p_as_of) GROUP BY 1) x;
  RETURN promote_or_reject('route_stats', v_params, p_as_of, COALESCE(v_n, 0), 0, NULL, true,
                           'descriptive statistics of verified flights; no prediction');
END $$;

-- ─── 8. User input-error patterns (flagged, explained, never silently applied)
CREATE TABLE IF NOT EXISTS public.user_pattern_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  pattern       text NOT NULL CHECK (pattern IN ('late_departure','early_departure','unresolved_locations','destination_mismatch')),
  status        text NOT NULL DEFAULT 'suspected' CHECK (status IN ('suspected','confirmed','dismissed','expired')),
  summary       text NOT NULL,
  evidence      jsonb NOT NULL,
  sample_size   integer NOT NULL,
  effect        numeric,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz,
  response_note text
);
CREATE UNIQUE INDEX IF NOT EXISTS user_pattern_flags_open
  ON public.user_pattern_flags (user_id, pattern) WHERE status IN ('suspected', 'confirmed');
ALTER TABLE public.user_pattern_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own pattern flags" ON public.user_pattern_flags;
CREATE POLICY "Users read own pattern flags" ON public.user_pattern_flags FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.user_pattern_flags FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.upsert_pattern_flag(p_user uuid, p_pattern text, p_holds boolean,
  p_summary text, p_evidence jsonb, p_n integer, p_effect numeric)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f record; d record;
BEGIN
  SELECT * INTO f FROM user_pattern_flags WHERE user_id = p_user AND pattern = p_pattern AND status IN ('suspected', 'confirmed');
  IF NOT p_holds THEN
    IF f.id IS NOT NULL AND f.status = 'suspected' THEN
      UPDATE user_pattern_flags SET status = 'expired', updated_at = now() WHERE id = f.id;
      RETURN 'expired';
    END IF;
    RETURN 'none';
  END IF;
  IF f.id IS NOT NULL THEN
    UPDATE user_pattern_flags SET summary = p_summary, evidence = p_evidence, sample_size = p_n, effect = p_effect, updated_at = now()
    WHERE id = f.id;
    RETURN 'updated';
  END IF;
  -- Respect a dismissal: re-raise only with ≥5 more flights of evidence, and not within 30 days.
  SELECT * INTO d FROM user_pattern_flags WHERE user_id = p_user AND pattern = p_pattern AND status = 'dismissed'
  ORDER BY responded_at DESC NULLS LAST LIMIT 1;
  IF d.id IS NOT NULL AND (d.responded_at > now() - interval '30 days' OR p_n < d.sample_size + 5) THEN
    RETURN 'suppressed_by_dismissal';
  END IF;
  INSERT INTO user_pattern_flags (user_id, pattern, summary, evidence, sample_size, effect)
  VALUES (p_user, p_pattern, p_summary, p_evidence, p_n, p_effect);
  RETURN 'raised';
END $$;

CREATE OR REPLACE FUNCTION public.detect_user_patterns(p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u record; v_n integer; v_k integer; v_med numeric; v_ev jsonb; v_out jsonb := '{}'::jsonb; v_r text;
BEGIN
  FOR u IN SELECT DISTINCT user_id FROM past_flights WHERE user_id IS NOT NULL AND available_at <= p_as_of
           UNION SELECT DISTINCT user_id FROM flight_intents WHERE user_id IS NOT NULL LOOP
    -- Late / early departure vs the filed window (GPS-measured take-off only).
    SELECT count(*),
           count(*) FILTER (WHERE actual_departure_at > planned_departure_end + interval '10 minutes'),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM actual_departure_at - planned_departure_end) / 60.0)
             FILTER (WHERE actual_departure_at > planned_departure_end + interval '10 minutes'),
           jsonb_agg(jsonb_build_object('past_flight_id', id, 'filed_window_end', planned_departure_end,
             'actual_departure', actual_departure_at,
             'minutes_after_window', round((extract(epoch FROM actual_departure_at - planned_departure_end) / 60.0)::numeric, 1))
             ORDER BY actual_departure_at DESC) FILTER (WHERE actual_departure_at > planned_departure_end + interval '10 minutes')
      INTO v_n, v_k, v_med, v_ev
    FROM (SELECT * FROM past_flights
          WHERE user_id = u.user_id AND telemetry_source = 'gps' AND actual_departure_at IS NOT NULL
            AND planned_departure_end IS NOT NULL AND NOT learning_excluded AND available_at <= p_as_of
          ORDER BY actual_departure_at DESC LIMIT 20) x;
    v_r := upsert_pattern_flag(u.user_id, 'late_departure', v_n >= 5 AND v_k::numeric / v_n >= 0.6,
      format('In %s of your last %s tracked flights, take-off was more than 10 min after the filed departure window (median %s min late).',
             v_k, v_n, round(COALESCE(v_med, 0))),
      jsonb_build_object('flights', COALESCE(v_ev, '[]'::jsonb), 'share', round(v_k::numeric / GREATEST(v_n, 1), 2),
                         'rule', '≥5 tracked flights and ≥60% departing >10 min after window'),
      v_n, v_med);
    v_out := v_out || jsonb_build_object(u.user_id::text || ':late_departure', v_r);

    SELECT count(*),
           count(*) FILTER (WHERE actual_departure_at < planned_departure_start - interval '10 minutes'),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM planned_departure_start - actual_departure_at) / 60.0)
             FILTER (WHERE actual_departure_at < planned_departure_start - interval '10 minutes'),
           jsonb_agg(jsonb_build_object('past_flight_id', id, 'filed_window_start', planned_departure_start,
             'actual_departure', actual_departure_at)) FILTER (WHERE actual_departure_at < planned_departure_start - interval '10 minutes')
      INTO v_n, v_k, v_med, v_ev
    FROM (SELECT * FROM past_flights
          WHERE user_id = u.user_id AND telemetry_source = 'gps' AND actual_departure_at IS NOT NULL
            AND planned_departure_start IS NOT NULL AND NOT learning_excluded AND available_at <= p_as_of
          ORDER BY actual_departure_at DESC LIMIT 20) x;
    v_r := upsert_pattern_flag(u.user_id, 'early_departure', v_n >= 5 AND v_k::numeric / v_n >= 0.6,
      format('In %s of your last %s tracked flights, take-off was more than 10 min before the filed window opened.', v_k, v_n),
      jsonb_build_object('flights', COALESCE(v_ev, '[]'::jsonb), 'rule', '≥5 tracked flights and ≥60% departing >10 min early'),
      v_n, v_med);

    -- Locations that could not be resolved when filing (input error).
    SELECT count(*), count(*) FILTER (WHERE coords_status IS DISTINCT FROM 'resolved'),
           jsonb_agg(jsonb_build_object('flight_intent_id', id, 'origin', origin, 'destination', destination,
             'coords_status', coords_status)) FILTER (WHERE coords_status IS DISTINCT FROM 'resolved')
      INTO v_n, v_k, v_ev
    FROM (SELECT id, origin, destination, coords_status FROM flight_intents
          WHERE user_id = u.user_id AND created_at <= p_as_of AND coords_status IS NOT NULL
          ORDER BY created_at DESC LIMIT 10) x;
    v_r := upsert_pattern_flag(u.user_id, 'unresolved_locations', v_n >= 5 AND v_k >= 3,
      format('%s of your last %s filings had an origin or destination that could not be located exactly.', v_k, v_n),
      jsonb_build_object('filings', COALESCE(v_ev, '[]'::jsonb), 'rule', '≥3 of the last ≥5 filings unresolved'),
      v_n, v_k);

    -- Flights that ended far from the filed destination.
    SELECT count(*), count(*) FILTER (WHERE end_distance_to_dest_m > 1000),
           jsonb_agg(jsonb_build_object('past_flight_id', id, 'destination', destination,
             'end_distance_m', end_distance_to_dest_m)) FILTER (WHERE end_distance_to_dest_m > 1000)
      INTO v_n, v_k, v_ev
    FROM (SELECT * FROM past_flights
          WHERE user_id = u.user_id AND telemetry_source = 'gps' AND end_distance_to_dest_m IS NOT NULL
            AND NOT learning_excluded AND available_at <= p_as_of
          ORDER BY archived_at DESC LIMIT 10) x;
    v_r := upsert_pattern_flag(u.user_id, 'destination_mismatch', v_n >= 5 AND v_k >= 3,
      format('%s of your last %s tracked flights ended more than 1 km from the destination you filed.', v_k, v_n),
      jsonb_build_object('flights', COALESCE(v_ev, '[]'::jsonb), 'rule', '≥3 of the last ≥5 tracked flights ended >1 km away'),
      v_n, v_k);
  END LOOP;
  RETURN jsonb_build_object('users', (SELECT count(*) FROM jsonb_object_keys(v_out)));
END $$;

-- Owner responds to a flag. Only confirmed flags influence guidance.
CREATE OR REPLACE FUNCTION public.respond_pattern_flag(p_flag uuid, p_response text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_response NOT IN ('confirm', 'dismiss') THEN RAISE EXCEPTION 'response must be confirm or dismiss'; END IF;
  UPDATE user_pattern_flags SET status = CASE p_response WHEN 'confirm' THEN 'confirmed' ELSE 'dismissed' END,
    responded_at = now(), updated_at = now(), response_note = left(p_note, 500)
  WHERE id = p_flag AND user_id = v_uid AND status IN ('suspected', 'confirmed')
  RETURNING status INTO v_status;
  IF v_status IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  RETURN jsonb_build_object('status', v_status);
END $$;

-- ─── 9. Learning cycle, integrity checks, retention ─────────────────────────
CREATE OR REPLACE FUNCTION public.run_learning_cycle(p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := '{}'::jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('shnav:learning_cycle'));
  v := v || jsonb_build_object('reconcile', reconcile_past_flights(1000));
  v := v || jsonb_build_object('verification_pairs', pair_forecast_verification(5000));
  v := v || jsonb_build_object('duration_calibration', train_duration_calibration(p_as_of));
  v := v || jsonb_build_object('wind_bias', train_wind_bias(p_as_of));
  v := v || jsonb_build_object('route_stats', train_route_stats(p_as_of));
  v := v || jsonb_build_object('user_patterns', detect_user_patterns(p_as_of));
  RETURN v;
END $$;

CREATE TABLE IF NOT EXISTS public.integrity_check_results (
  id        bigserial PRIMARY KEY,
  run_at    timestamptz NOT NULL DEFAULT now(),
  check_name text NOT NULL,
  status    text NOT NULL CHECK (status IN ('pass','warn','fail')),
  count     integer NOT NULL DEFAULT 0,
  sample    jsonb
);
CREATE INDEX IF NOT EXISTS idx_integrity_time ON public.integrity_check_results (run_at DESC);
ALTER TABLE public.integrity_check_results ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.run_integrity_checks()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_out jsonb := '{}'::jsonb; v_n integer; v_s jsonb; v_status text; c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('stale_sources', 'fail',
     $q$SELECT id AS k FROM data_sources WHERE enabled AND cadence_seconds IS NOT NULL
          AND (run_condition = 'always' OR has_active_operations())
          AND COALESCE(last_success_at, 'epoch') < now() - make_interval(secs => cadence_seconds * 3 + 300)$q$),
    ('archived_without_past_record', 'fail',
     $q$SELECT id::text AS k FROM flight_intents fi WHERE status = 'archived'
          AND NOT EXISTS (SELECT 1 FROM past_flights p WHERE p.flight_intent_id = fi.id)$q$),
    ('aircraft_airborne_twice', 'fail',
     $q$SELECT aircraft_id AS k FROM flight_intents WHERE status IN ('in_air','active') GROUP BY aircraft_id HAVING count(*) > 1$q$),
    ('orphan_time_slots', 'warn',
     $q$SELECT id::text AS k FROM time_slots ts WHERE flight_intent_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM flight_intents fi WHERE fi.id = ts.flight_intent_id)$q$),
    ('active_slots_for_ended_flights', 'warn',
     $q$SELECT ts.id::text AS k FROM time_slots ts JOIN flight_intents fi ON fi.id = ts.flight_intent_id
          WHERE fi.status IN ('archived','expired') AND ts.status IN ('allocated','active')$q$),
    ('past_flights_time_order', 'fail',
     $q$SELECT id::text AS k FROM past_flights WHERE actual_arrival_at <= actual_departure_at AND NOT learning_excluded$q$),
    ('verified_without_telemetry', 'fail',
     $q$SELECT id::text AS k FROM past_flights WHERE verification_status = 'verified' AND telemetry_points < 10$q$),
    ('rejected_observations_24h', 'warn',
     $q$SELECT station AS k FROM wx_metar WHERE quality = 'rejected' AND fetched_at > now() - interval '24 hours'$q$),
    ('multiple_active_models', 'fail',
     $q$SELECT kind AS k FROM model_params WHERE status = 'active' GROUP BY kind HAVING count(*) > 1$q$),
    ('unpaired_verification_backlog', 'warn',
     $q$SELECT s.id::text AS k FROM wx_forecast_snapshots s WHERE purpose = 'verification' AND valid_at < now() - interval '6 hours'
          AND NOT EXISTS (SELECT 1 FROM wx_verification v WHERE v.snapshot_id = s.id)
          AND EXISTS (SELECT 1 FROM wx_metar m WHERE m.station = s.station AND m.obs_time BETWEEN s.valid_at - interval '10 minutes' AND s.valid_at + interval '10 minutes')$q$)
  ) AS t(name, severity, sql) LOOP
    EXECUTE format('SELECT count(*)::int, (SELECT jsonb_agg(k) FROM (SELECT k FROM (%s) a LIMIT 10) b) FROM (%s) z', c.sql, c.sql)
      INTO v_n, v_s;
    v_status := CASE WHEN v_n = 0 THEN 'pass' ELSE c.severity END;
    INSERT INTO integrity_check_results (check_name, status, count, sample) VALUES (c.name, v_status, v_n, v_s);
    v_out := v_out || jsonb_build_object(c.name, jsonb_build_object('status', v_status, 'count', v_n));
    IF v_status = 'fail' THEN
      INSERT INTO alert_events (kind, dedupe_key, message, details)
      VALUES ('integrity', 'integrity:' || c.name || ':' || to_char(date_trunc('hour', now()), 'YYYY-MM-DD"T"HH24'),
              format('SHNAV integrity check %s failed (%s rows)', c.name, v_n), jsonb_build_object('sample', v_s))
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;
  END LOOP;
  DELETE FROM integrity_check_results WHERE run_at < now() - interval '30 days';
  RETURN v_out;
END $$;

-- Raw ADS-B is high volume: keep 14 days. Weather observations, forecasts used
-- for verification, telemetry and past flights are kept permanently.
CREATE OR REPLACE FUNCTION public.prune_ingest_data()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t integer; v_r integer;
BEGIN
  DELETE FROM traffic_observations WHERE observed_at < now() - interval '14 days';
  GET DIAGNOSTICS v_t = ROW_COUNT;
  DELETE FROM ingest_runs WHERE started_at < now() - interval '30 days';
  GET DIAGNOSTICS v_r = ROW_COUNT;
  RETURN jsonb_build_object('traffic_observations', v_t, 'ingest_runs', v_r);
END $$;

-- pg_cron → data-ingest edge function (via pg_net). Needs two settings:
--   INSERT INTO app_private.settings VALUES ('functions_base_url', 'https://<ref>.supabase.co/functions/v1'),
--                                           ('internal_function_secret', '<same as INTERNAL_FUNCTION_SECRET>');
CREATE OR REPLACE FUNCTION public.dispatch_ingest()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url text; v_secret text; v_due text[]; v_req bigint;
BEGIN
  SELECT array_agg(s) INTO v_due FROM ingest_due_sources() s;
  IF v_due IS NULL THEN RETURN jsonb_build_object('due', 0); END IF;
  SELECT value INTO v_url FROM app_private.settings WHERE key = 'functions_base_url';
  SELECT value INTO v_secret FROM app_private.settings WHERE key = 'internal_function_secret';
  IF v_url IS NULL OR v_secret IS NULL OR to_regnamespace('net') IS NULL THEN
    RETURN jsonb_build_object('due', array_length(v_due, 1), 'dispatched', false,
                              'reason', 'functions_base_url / internal_function_secret / pg_net missing');
  END IF;
  EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 55000)' INTO v_req
    USING rtrim(v_url, '/') || '/data-ingest', jsonb_build_object('sources', to_jsonb(v_due)),
          jsonb_build_object('Content-Type', 'application/json', 'X-Internal-Secret', v_secret);
  RETURN jsonb_build_object('due', array_length(v_due, 1), 'dispatched', true, 'request_id', v_req);
END $$;

-- ─── 10. Privileges ─────────────────────────────────────────────────────────
-- Observations are public-domain/open data: signed-in users may read them.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['wx_metar','wx_taf','wx_advisories','airspace_restrictions','traffic_observations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Signed-in users read %s" ON public.%I', t, t);
    EXECUTE format('CREATE POLICY "Signed-in users read %s" ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
  END LOOP;
END $$;
GRANT SELECT ON public.airspace_restrictions_current TO authenticated;
REVOKE ALL ON public.airspace_restrictions_current FROM anon;

-- Source freshness (no ETags/errors) for the UI.
CREATE OR REPLACE VIEW public.data_source_status WITH (security_invoker = false) AS
  SELECT id, name, kind, cadence_seconds, reliability, run_condition, enabled, licence,
         last_success_at, last_data_at, consecutive_failures,
         CASE
           WHEN NOT enabled THEN 'disabled'
           WHEN cadence_seconds IS NULL THEN 'on_demand'
           WHEN last_success_at IS NULL THEN 'never'
           WHEN last_success_at < now() - make_interval(secs => cadence_seconds * 3 + 300) THEN 'stale'
           WHEN consecutive_failures > 0 THEN 'degraded'
           ELSE 'fresh' END AS freshness
  FROM public.data_sources;
REVOKE ALL ON public.data_source_status FROM anon;
GRANT SELECT ON public.data_source_status TO authenticated, service_role;
GRANT SELECT ON public.airspace_restrictions_current TO service_role;

REVOKE ALL ON public.data_sources, public.ingest_runs, public.wx_forecast_snapshots, public.model_params,
              public.record_corrections, public.integrity_check_results FROM anon, authenticated;
REVOKE ALL ON public.wx_verification FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.past_flights, public.prediction_errors FROM anon, authenticated;

-- LEAKAGE GUARD: the API service role (used by every planning edge function)
-- cannot touch outcome history at all. Past outcomes reach planning only as
-- promoted model_params, produced by the as-of training functions above.
REVOKE ALL ON public.past_flights, public.prediction_errors, public.wx_verification,
              public.record_corrections FROM service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ingest_claim(text,boolean)',
    'ingest_finish(bigint,text,integer,integer,integer,integer,integer,text,text,text,integer,timestamptz)',
    'ingest_due_sources()', 'budget_allows(text,integer)', 'has_active_operations()',
    'withdraw_missing_restrictions(text,text[])', 'pair_forecast_verification(integer)',
    'nearest_metar(double precision,double precision,timestamptz,double precision,interval)', 'try_timestamptz(text)',
    'ingest_telemetry(uuid,uuid,jsonb)', 'active_model_params()',
    'finalize_flight(uuid,boolean)', 'finalize_ended_flights(integer)',
    'record_flight_outcome_tx(uuid,uuid,jsonb)', 'refresh_fleet_route_patterns()',
    'apply_correction(text,uuid,text,jsonb,text,jsonb,text)',
    'reconcile_past_flight(uuid)', 'reconcile_past_flights(integer)',
    'promote_or_reject(text,jsonb,timestamptz,integer,integer,jsonb,boolean,text)',
    'train_duration_calibration(timestamptz,integer)', 'train_wind_bias(timestamptz,integer)',
    'train_route_stats(timestamptz)', 'upsert_pattern_flag(uuid,text,boolean,text,jsonb,integer,numeric)',
    'detect_user_patterns(timestamptz)', 'run_learning_cycle(timestamptz)', 'run_integrity_checks()',
    'prune_ingest_data()', 'dispatch_ingest()', 'archive_landed_flight()', 'guard_past_flights()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  -- Training/reconciliation read outcome history: cron/postgres only.
  FOREACH f IN ARRAY ARRAY[
    'training_flights(timestamptz)', 'reconcile_past_flight(uuid)', 'reconcile_past_flights(integer)',
    'train_duration_calibration(timestamptz,integer)', 'train_wind_bias(timestamptz,integer)',
    'train_route_stats(timestamptz)', 'detect_user_patterns(timestamptz)', 'run_learning_cycle(timestamptz)',
    'apply_correction(text,uuid,text,jsonb,text,jsonb,text)', 'promote_or_reject(text,jsonb,timestamptz,integer,integer,jsonb,boolean,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.respond_pattern_flag(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_pattern_flag(uuid, text, text) TO authenticated;

-- ─── 11. Legacy backfill: every ended flight becomes a past flight ──────────
-- Pre-telemetry flights cannot be verified; they are preserved as
-- legacy_unverified and never used for learning.
INSERT INTO public.past_flights (flight_intent_id, user_id, aircraft_id, operator_name, origin, destination,
  origin_lat, origin_lon, dest_lat, dest_lon, altitude_band, filed_at, planned_departure_start, planned_departure_end,
  final_status, verification_status, verification_notes, telemetry_source, planned_route, planned_duration_min,
  prediction_snapshot, outcome_reported, weather_obs_status, learning_excluded, learning_exclusion_reason,
  reconciled_at, archived_at, available_at)
SELECT fi.id, fi.user_id, fi.aircraft_id, fi.operator_name, fi.origin, fi.destination,
  fi.origin_lat, fi.origin_lon, fi.dest_lat, fi.dest_lon, fi.altitude_band, fi.created_at,
  fi.departure_start_at, fi.departure_end_at,
  'legacy', 'legacy_unverified',
  ARRAY['migrated 2026-11-15: pre-dates server telemetry; outcome values were client-reported and cannot be verified',
        'previous status: ' || fi.status],
  'none', rt.primary_route->'waypoints', NULLIF(rt.primary_route->>'estimated_time_min', '')::numeric,
  jsonb_strip_nulls(jsonb_build_object('overall_score', rt.overall_score, 'weather_risk', COALESCE(rt.weather_risk, fi.weather_risk),
    'trajectory_score', fi.trajectory_score, 'conflicts', fi.conflicts)),
  CASE WHEN oc.id IS NOT NULL THEN to_jsonb(oc) - 'flight_intent_id' END,
  'not_applicable', true, 'legacy record without verifiable telemetry', now(),
  COALESCE(fi.archived_at, fi.landed_at, fi.expired_at, now()), now()
FROM public.flight_intents fi
LEFT JOIN LATERAL (SELECT * FROM public.routes r WHERE r.flight_intent_id = fi.id ORDER BY r.created_at DESC LIMIT 1) rt ON true
LEFT JOIN public.flight_outcomes oc ON oc.flight_intent_id = fi.id
WHERE fi.status IN ('archived', 'landed', 'expired')
ON CONFLICT (flight_intent_id) DO NOTHING;

-- historical_flights rows whose intent no longer exists.
INSERT INTO public.past_flights (flight_intent_id, user_id, aircraft_id, operator_name, origin, destination,
  planned_departure_start, final_status, verification_status, verification_notes, telemetry_source,
  prediction_snapshot, weather_obs_status, learning_excluded, learning_exclusion_reason, reconciled_at, archived_at, available_at)
SELECT h.flight_intent_id, h.user_id, h.aircraft_id, h.operator_name, h.origin, h.destination,
  h.scheduled_departure, 'legacy', 'legacy_unverified',
  ARRAY['migrated 2026-11-15 from historical_flights; original flight record no longer exists'],
  'none', jsonb_strip_nulls(jsonb_build_object('trajectory_score', h.trajectory_score, 'weather_risk', h.weather_risk, 'conflicts', h.conflicts)),
  'not_applicable', true, 'legacy record without verifiable telemetry', now(), h.archived_at, now()
FROM public.historical_flights h
WHERE NOT EXISTS (SELECT 1 FROM public.past_flights p WHERE p.flight_intent_id = h.flight_intent_id);

UPDATE public.flight_intents SET status = 'archived'
WHERE status IN ('landed', 'expired')
  AND EXISTS (SELECT 1 FROM public.past_flights p WHERE p.flight_intent_id = flight_intents.id);

-- ─── 12. Evidence-based corrections of legacy values (originals logged) ─────
-- Weights were self-modified per flight without validation; restore the
-- configured values (archived copy in archive_20261115.route_score_config).
UPDATE public.route_score_config SET weight_safety = 0.35, weight_weather = 0.25, weight_traffic = 0.25,
  weight_efficiency = 0.15, weight_time = 0.20, weight_fuel = 0.10, total_outcomes_seen = 0, updated_at = now();

DO $$
DECLARE r record; c text;
  ev_zero jsonb := '{"rule":"record_flight_outcome_tx up to 2026-11-02 stored 0 when the client sent no measurement","all_experienced_fields_zero":true}';
BEGIN
  -- "Experienced" wind/gust/deviation that are all exactly 0 were coerced defaults, not measurements.
  FOR r IN SELECT id, experienced_turbulence_probability t FROM public.flight_outcomes
           WHERE experienced_max_wind_kmh = 0 AND experienced_max_gusts_kmh = 0 AND COALESCE(experienced_route_deviation_m, 0) = 0 LOOP
    PERFORM public.apply_correction('flight_outcomes', r.id, 'experienced_max_wind_kmh', 'null', 'coerced default, not a measurement', ev_zero, 'migration:20261115');
    PERFORM public.apply_correction('flight_outcomes', r.id, 'experienced_max_gusts_kmh', 'null', 'coerced default, not a measurement', ev_zero, 'migration:20261115');
    PERFORM public.apply_correction('flight_outcomes', r.id, 'experienced_route_deviation_m', 'null', 'coerced default, not a measurement', ev_zero, 'migration:20261115');
    IF r.t = 0 THEN
      PERFORM public.apply_correction('flight_outcomes', r.id, 'experienced_turbulence_probability', 'null', 'coerced default, not a measurement', ev_zero, 'migration:20261115');
    END IF;
  END LOOP;
  -- Scores are defined on 0–100; values outside came from the pre-clampScore bug.
  FOR r IN SELECT id, trajectory_score s FROM public.flight_intents WHERE trajectory_score > 100 OR trajectory_score < 0 LOOP
    PERFORM public.apply_correction('flight_intents', r.id, 'trajectory_score', to_jsonb(GREATEST(0, LEAST(100, r.s))),
      'score outside the defined 0–100 range', jsonb_build_object('rule', 'scores are defined on 0–100 (clampScore, 2026-10-19)', 'original', r.s), 'migration:20261115');
  END LOOP;
  FOREACH c IN ARRAY ARRAY['overall_score', 'safety_score', 'weather_score', 'traffic_score', 'efficiency_score'] LOOP
    FOR r IN EXECUTE format('SELECT id, %I AS s FROM public.routes WHERE %I > 100 OR %I < 0', c, c, c) LOOP
      PERFORM public.apply_correction('routes', r.id, c, to_jsonb(GREATEST(0, LEAST(100, r.s))),
        'score outside the defined 0–100 range', jsonb_build_object('rule', 'scores are defined on 0–100 (clampScore, 2026-10-19)', 'original', r.s), 'migration:20261115');
    END LOOP;
  END LOOP;
  -- Stored "weather" that is the unavailable-forecast placeholder (all zero, no temperature).
  FOR r IN SELECT id FROM public.routes WHERE weather_conditions IS NOT NULL
             AND (weather_conditions->>'wind_speed')::numeric = 0 AND (weather_conditions->>'wind_gusts')::numeric = 0
             AND weather_conditions->>'temperature' IS NULL LOOP
    PERFORM public.apply_correction('routes', r.id, 'weather_conditions', 'null',
      'placeholder from an unavailable forecast, stored as if observed calm',
      '{"rule":"wind 0, gusts 0 and no temperature = UNAVAILABLE_WX placeholder"}', 'migration:20261115');
  END LOOP;
END $$;

-- Close out flights that are already over (stuck airborne, long-expired) now
-- rather than waiting for the first cron tick.
SELECT public.expire_stale_intents();
SELECT public.finalize_ended_flights(5000);

-- ─── 13. Background jobs ────────────────────────────────────────────────────
DO $$
DECLARE j text;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'cron schema absent — skipping job scheduling';
    RETURN;
  END IF;
  FOREACH j IN ARRAY ARRAY['shnav-ingest-dispatch', 'shnav-finalize-flights', 'shnav-pair-verification',
                           'shnav-reconcile', 'shnav-learning-cycle', 'shnav-integrity', 'shnav-prune-ingest'] LOOP
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = j;
  END LOOP;
  PERFORM cron.schedule('shnav-ingest-dispatch',   '* * * * *',    'SELECT public.dispatch_ingest()');
  PERFORM cron.schedule('shnav-finalize-flights',  '*/5 * * * *',  'SELECT public.finalize_ended_flights()');
  PERFORM cron.schedule('shnav-pair-verification','*/15 * * * *', 'SELECT public.pair_forecast_verification()');
  PERFORM cron.schedule('shnav-reconcile',         '*/30 * * * *', 'SELECT public.reconcile_past_flights()');
  PERFORM cron.schedule('shnav-learning-cycle',    '30 4 * * *',   'SELECT public.run_learning_cycle()');
  PERFORM cron.schedule('shnav-integrity',         '20 * * * *',   'SELECT public.run_integrity_checks()');
  PERFORM cron.schedule('shnav-prune-ingest',      '40 3 * * *',   'SELECT public.prune_ingest_data()');
END $$;
