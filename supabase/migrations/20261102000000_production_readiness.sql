-- ============================================================================
-- Production readiness (2026-11-02)
-- ============================================================================
-- Rollback: supabase/rollback/20261102000000_production_readiness.down.sql
--
--  1. flight_intents: absolute (UTC) departure window, resolved coordinates,
--     idempotency key, stored analysis result, server-side assessments.
--  2. Client write lockdown: clients may only move status pending→in_air→landed.
--  3. One reservation per flight (time_slots / vertiport_slots) + atomic,
--     lock-protected capacity reservation functions (no check-then-insert race).
--  4. Atomic learning-loop functions (route patterns, flight outcomes) — no
--     lost updates, no double-counted outcomes.
--  5. Decision history: route_candidate_id (REROUTE decisions previously failed
--     to save — candidate ids are text, route_id is a uuid FK) + superseded flag.
--  6. Geocode cache (stops repeated Nominatim calls).
--  7. Observability: error_events, api_usage + budgets, alert_events with
--     delivery retries.
--  8. Real vertiports (FAA-registered NYC heliports/airports) replace the
--     fictional seed rows (deactivated, not deleted — history stays intact).
--  9. Background jobs via pg_cron (guarded: skipped where pg_cron is absent).
-- ============================================================================

-- ─── 1. flight_intents ──────────────────────────────────────────────────────
ALTER TABLE public.flight_intents
  ADD COLUMN IF NOT EXISTS departure_start_at   timestamptz,
  ADD COLUMN IF NOT EXISTS departure_end_at     timestamptz,
  ADD COLUMN IF NOT EXISTS origin_lat           double precision,
  ADD COLUMN IF NOT EXISTS origin_lon           double precision,
  ADD COLUMN IF NOT EXISTS dest_lat             double precision,
  ADD COLUMN IF NOT EXISTS dest_lon             double precision,
  ADD COLUMN IF NOT EXISTS coords_status        text,
  ADD COLUMN IF NOT EXISTS idempotency_key      text,
  ADD COLUMN IF NOT EXISTS analysis_result      jsonb,
  ADD COLUMN IF NOT EXISTS airspace_assessment  jsonb,
  ADD COLUMN IF NOT EXISTS vertiport_assessment jsonb,
  ADD COLUMN IF NOT EXISTS expired_at           timestamptz;

DO $$ BEGIN
  ALTER TABLE public.flight_intents
    ADD CONSTRAINT flight_intents_coords_status_chk
    CHECK (coords_status IS NULL OR coords_status IN ('resolved', 'partial', 'unresolved'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.flight_intents
    ADD CONSTRAINT flight_intents_departure_order_chk
    CHECK (departure_start_at IS NULL OR departure_end_at IS NULL OR departure_end_at >= departure_start_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS flight_intents_idempotency_unique
  ON public.flight_intents (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flight_intents_status_departure
  ON public.flight_intents (status, departure_start_at);

-- Backfill absolute windows where the old rows carry enough information.
UPDATE public.flight_intents
SET departure_start_at = scheduled_departure,
    departure_end_at = scheduled_departure + make_interval(mins => GREATEST(0,
      (split_part(departure_window_end, ':', 1)::int * 60 + split_part(departure_window_end, ':', 2)::int)
      - (split_part(departure_window_start, ':', 1)::int * 60 + split_part(departure_window_start, ':', 2)::int)))
WHERE departure_start_at IS NULL
  AND scheduled_departure IS NOT NULL
  AND departure_window_start ~ '^\d{2}:\d{2}$'
  AND departure_window_end ~ '^\d{2}:\d{2}$';

-- ─── 2. Client write lockdown ───────────────────────────────────────────────
-- Intents are created only by the trajectory-analysis function (service role).
DROP POLICY IF EXISTS "Users insert own intents" ON public.flight_intents;
REVOKE INSERT, DELETE, UPDATE ON public.flight_intents FROM anon, authenticated;
GRANT UPDATE (status, landed_at) ON public.flight_intents TO authenticated;

DROP POLICY IF EXISTS "Users update own intents" ON public.flight_intents;
CREATE POLICY "Users update own intents" ON public.flight_intents
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Clients may only report take-off and landing. Named "aa_" so it fires before
-- trg_flight_intents_archive (BEFORE triggers run in name order), which
-- rewrites landed → archived.
CREATE OR REPLACE FUNCTION public.enforce_client_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status IN ('pending', 'approved') AND NEW.status = 'in_air') OR
      (OLD.status IN ('in_air', 'active') AND NEW.status = 'landed')
    ) THEN
      RAISE EXCEPTION 'status transition % -> % is not allowed', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_flight_intents_aa_client_guard ON public.flight_intents;
CREATE TRIGGER trg_flight_intents_aa_client_guard
  BEFORE UPDATE ON public.flight_intents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_status_transition();

-- ─── 3. One reservation per flight ─────────────────────────────────────────
-- Remove duplicates created by route re-selection (keep the newest).
DELETE FROM public.time_slots a
USING public.time_slots b
WHERE a.flight_intent_id IS NOT NULL
  AND a.flight_intent_id = b.flight_intent_id
  AND (COALESCE(a.created_at, 'epoch'), a.id) < (COALESCE(b.created_at, 'epoch'), b.id);
CREATE UNIQUE INDEX IF NOT EXISTS time_slots_one_per_intent
  ON public.time_slots (flight_intent_id) WHERE flight_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_time_slots_segment_start ON public.time_slots (segment_id, slot_start);

DELETE FROM public.vertiport_slots a
USING public.vertiport_slots b
WHERE a.flight_intent_id IS NOT NULL
  AND a.flight_intent_id = b.flight_intent_id
  AND a.slot_type = b.slot_type
  AND (COALESCE(a.created_at, 'epoch'), a.id) < (COALESCE(b.created_at, 'epoch'), b.id);
CREATE UNIQUE INDEX IF NOT EXISTS vertiport_slots_one_per_intent_type
  ON public.vertiport_slots (flight_intent_id, slot_type) WHERE flight_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vertiport_slots_vp_type_time
  ON public.vertiport_slots (vertiport_id, slot_type, scheduled_time);

-- Statuses whose reservations still consume capacity.
CREATE OR REPLACE FUNCTION public.intent_is_live(p_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status IN ('analyzing', 'pending', 'approved', 'active', 'in_air')
$$;

-- Atomic airspace slot reservation. The altitude band is treated as one shared
-- airspace (segments carry no corridor geometry), capacity = sum of the band's
-- open segments per hour. Load = reservations whose slot starts within the
-- 1-hour window centred on the candidate time. Tries +0..+60 min in 15-min steps.
CREATE OR REPLACE FUNCTION public.reserve_airspace_slot(
  p_intent    uuid,
  p_aircraft  text,
  p_band      text,
  p_start     timestamptz,
  p_priority  integer,
  p_emergency boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cap        integer;
  v_anchor     record;
  v_try        timestamptz;
  v_load       integer;
  v_load_req   integer;
  v_delay      integer;
  v_allocated  boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('airspace:' || coalesce(p_band, '')));

  SELECT COALESCE(SUM(capacity_per_hour), 0) INTO v_cap
  FROM airspace_segments WHERE altitude_band = p_band AND NOT is_no_fly;
  SELECT id, name INTO v_anchor
  FROM airspace_segments WHERE altitude_band = p_band AND NOT is_no_fly
  ORDER BY capacity_per_hour DESC, name LIMIT 1;

  IF v_cap = 0 OR v_anchor.id IS NULL THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'No open airspace segment for band ' || p_band,
      'capacity_per_hour', 0, 'load', 0, 'load_percentage', 100, 'delay_minutes', null,
      'segment_name', null, 'computed_at', now());
  END IF;

  FOR v_delay IN SELECT generate_series(0, 60, 15) LOOP
    v_try := p_start + make_interval(mins => v_delay);
    SELECT count(*) INTO v_load
    FROM time_slots ts
    JOIN airspace_segments s ON s.id = ts.segment_id
    JOIN flight_intents fi ON fi.id = ts.flight_intent_id
    WHERE s.altitude_band = p_band
      AND ts.status IN ('allocated', 'active')
      AND intent_is_live(fi.status)
      AND ts.flight_intent_id <> p_intent
      AND ts.slot_start >= v_try - interval '30 minutes'
      AND ts.slot_start <  v_try + interval '30 minutes';
    IF v_delay = 0 THEN v_load_req := v_load; END IF;
    IF p_emergency OR v_load < v_cap THEN
      v_allocated := true;
      EXIT;
    END IF;
  END LOOP;

  IF v_allocated THEN
    INSERT INTO time_slots (segment_id, flight_intent_id, aircraft_id, slot_start, slot_end, priority, status)
    VALUES (v_anchor.id, p_intent, p_aircraft, v_try, v_try + interval '30 minutes', p_priority, 'allocated')
    ON CONFLICT (flight_intent_id) WHERE flight_intent_id IS NOT NULL
    DO UPDATE SET segment_id = EXCLUDED.segment_id, slot_start = EXCLUDED.slot_start,
                  slot_end = EXCLUDED.slot_end, priority = EXCLUDED.priority, status = 'allocated';
  ELSE
    DELETE FROM time_slots WHERE flight_intent_id = p_intent;
  END IF;

  RETURN jsonb_build_object(
    'allocated', v_allocated,
    'allocated_time', CASE WHEN v_allocated THEN v_try END,
    'delay_minutes', CASE WHEN v_allocated THEN v_delay END,
    'capacity_per_hour', v_cap,
    'load', v_load_req,
    'load_percentage', round(100.0 * v_load_req / v_cap),
    'segment_name', v_anchor.name || ' (' || p_band || ' band)',
    'emergency', p_emergency,
    'computed_at', now()
  );
END $$;

-- Atomic vertiport departure/arrival reservation. Either side may be NULL
-- (no registered vertiport near that endpoint) — that side is not checked.
-- Locks are taken in id order so concurrent callers cannot deadlock.
CREATE OR REPLACE FUNCTION public.reserve_vertiport_slots(
  p_intent         uuid,
  p_aircraft       text,
  p_origin_vp      uuid,
  p_dest_vp        uuid,
  p_departure      timestamptz,
  p_flight_minutes integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_o record; v_d record;
  v_delay integer; v_dep timestamptz; v_arr timestamptz;
  v_dep_load integer := 0; v_arr_load integer := 0;
  v_dep_load_req integer := 0; v_arr_load_req integer := 0;
  v_ok boolean := false;
  v_lock uuid;
BEGIN
  FOR v_lock IN SELECT x FROM unnest(ARRAY[p_origin_vp, p_dest_vp]) x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(hashtext('vertiport:' || v_lock::text));
  END LOOP;

  SELECT id, name, max_departures_per_hour AS cap INTO v_o FROM vertiports WHERE id = p_origin_vp;
  SELECT id, name, max_arrivals_per_hour AS cap INTO v_d FROM vertiports WHERE id = p_dest_vp;

  FOR v_delay IN SELECT generate_series(0, 60, 5) LOOP
    v_dep := p_departure + make_interval(mins => v_delay);
    v_arr := v_dep + make_interval(mins => p_flight_minutes);
    IF v_o.id IS NOT NULL THEN
      SELECT count(*) INTO v_dep_load FROM vertiport_slots vs JOIN flight_intents fi ON fi.id = vs.flight_intent_id
      WHERE vs.vertiport_id = v_o.id AND vs.slot_type = 'departure'
        AND vs.status IN ('scheduled', 'active', 'delayed') AND intent_is_live(fi.status)
        AND vs.flight_intent_id <> p_intent
        AND vs.scheduled_time >= v_dep - interval '30 minutes' AND vs.scheduled_time < v_dep + interval '30 minutes';
    END IF;
    IF v_d.id IS NOT NULL THEN
      SELECT count(*) INTO v_arr_load FROM vertiport_slots vs JOIN flight_intents fi ON fi.id = vs.flight_intent_id
      WHERE vs.vertiport_id = v_d.id AND vs.slot_type = 'arrival'
        AND vs.status IN ('scheduled', 'active', 'delayed') AND intent_is_live(fi.status)
        AND vs.flight_intent_id <> p_intent
        AND vs.scheduled_time >= v_arr - interval '30 minutes' AND vs.scheduled_time < v_arr + interval '30 minutes';
    END IF;
    IF v_delay = 0 THEN v_dep_load_req := v_dep_load; v_arr_load_req := v_arr_load; END IF;
    IF (v_o.id IS NULL OR v_dep_load < v_o.cap) AND (v_d.id IS NULL OR v_arr_load < v_d.cap) THEN
      v_ok := true; EXIT;
    END IF;
  END LOOP;

  DELETE FROM vertiport_slots WHERE flight_intent_id = p_intent;
  IF v_ok THEN
    IF v_o.id IS NOT NULL THEN
      INSERT INTO vertiport_slots (vertiport_id, flight_intent_id, aircraft_id, slot_type, scheduled_time, status, delay_minutes)
      VALUES (v_o.id, p_intent, p_aircraft, 'departure', v_dep, 'scheduled', v_delay);
    END IF;
    IF v_d.id IS NOT NULL THEN
      INSERT INTO vertiport_slots (vertiport_id, flight_intent_id, aircraft_id, slot_type, scheduled_time, status, delay_minutes)
      VALUES (v_d.id, p_intent, p_aircraft, 'arrival', v_arr, 'scheduled', v_delay);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'reserved', v_ok,
    'delay_minutes', CASE WHEN v_ok THEN v_delay END,
    'adjusted_departure_time', CASE WHEN v_ok THEN v_dep END,
    'estimated_arrival_time', CASE WHEN v_ok THEN v_arr END,
    'origin', CASE WHEN v_o.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_o.id, 'name', v_o.name, 'capacity_per_hour', v_o.cap, 'load', v_dep_load_req,
      'load_pct', round(100.0 * v_dep_load_req / GREATEST(v_o.cap, 1)), 'capacity_ok', v_dep_load_req < v_o.cap) END,
    'destination', CASE WHEN v_d.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_d.id, 'name', v_d.name, 'capacity_per_hour', v_d.cap, 'load', v_arr_load_req,
      'load_pct', round(100.0 * v_arr_load_req / GREATEST(v_d.cap, 1)), 'capacity_ok', v_arr_load_req < v_d.cap) END,
    'computed_at', now()
  );
END $$;

-- ─── 4. Atomic learning loop ───────────────────────────────────────────────
-- Normalised OD key: text before the "@ lat,lon" geocode tag, lower-cased.
CREATE OR REPLACE FUNCTION public.od_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(split_part(lower(coalesce(p, '')), '@', 1))
$$;

CREATE OR REPLACE FUNCTION public.upsert_route_pattern(
  p_user uuid, p_origin_key text, p_dest_key text, p_band text,
  p_overall numeric, p_safety numeric, p_weather numeric, p_traffic numeric, p_efficiency numeric,
  p_waypoints jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_user IS NULL THEN
    INSERT INTO route_patterns AS rp (origin_key, destination_key, altitude_band, user_id, flight_count,
      avg_overall_score, avg_safety_score, avg_weather_score, avg_traffic_score, avg_efficiency_score,
      preferred_waypoints, last_updated)
    VALUES (p_origin_key, p_dest_key, p_band, NULL, 1, p_overall, p_safety, p_weather, p_traffic, p_efficiency, p_waypoints, now())
    ON CONFLICT (origin_key, destination_key, altitude_band) WHERE user_id IS NULL DO UPDATE SET
      avg_overall_score    = (COALESCE(rp.avg_overall_score, 0)    * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_overall_score)    / (COALESCE(rp.flight_count, 0) + 1),
      avg_safety_score     = (COALESCE(rp.avg_safety_score, 0)     * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_safety_score)     / (COALESCE(rp.flight_count, 0) + 1),
      avg_weather_score    = (COALESCE(rp.avg_weather_score, 0)    * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_weather_score)    / (COALESCE(rp.flight_count, 0) + 1),
      avg_traffic_score    = (COALESCE(rp.avg_traffic_score, 0)    * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_traffic_score)    / (COALESCE(rp.flight_count, 0) + 1),
      avg_efficiency_score = (COALESCE(rp.avg_efficiency_score, 0) * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_efficiency_score) / (COALESCE(rp.flight_count, 0) + 1),
      flight_count = COALESCE(rp.flight_count, 0) + 1,
      preferred_waypoints = EXCLUDED.preferred_waypoints,
      last_updated = now();
  ELSE
    INSERT INTO route_patterns AS rp (origin_key, destination_key, altitude_band, user_id, flight_count,
      avg_overall_score, avg_safety_score, avg_weather_score, avg_traffic_score, avg_efficiency_score,
      preferred_waypoints, last_updated)
    VALUES (p_origin_key, p_dest_key, p_band, p_user, 1, p_overall, p_safety, p_weather, p_traffic, p_efficiency, p_waypoints, now())
    ON CONFLICT (user_id, origin_key, destination_key, altitude_band) WHERE user_id IS NOT NULL DO UPDATE SET
      avg_overall_score    = (COALESCE(rp.avg_overall_score, 0)    * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_overall_score)    / (COALESCE(rp.flight_count, 0) + 1),
      avg_safety_score     = (COALESCE(rp.avg_safety_score, 0)     * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_safety_score)     / (COALESCE(rp.flight_count, 0) + 1),
      avg_weather_score    = (COALESCE(rp.avg_weather_score, 0)    * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_weather_score)    / (COALESCE(rp.flight_count, 0) + 1),
      avg_traffic_score    = (COALESCE(rp.avg_traffic_score, 0)    * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_traffic_score)    / (COALESCE(rp.flight_count, 0) + 1),
      avg_efficiency_score = (COALESCE(rp.avg_efficiency_score, 0) * COALESCE(rp.flight_count, 0) + EXCLUDED.avg_efficiency_score) / (COALESCE(rp.flight_count, 0) + 1),
      flight_count = COALESCE(rp.flight_count, 0) + 1,
      preferred_waypoints = EXCLUDED.preferred_waypoints,
      last_updated = now();
  END IF;
END $$;

-- Records a flight outcome exactly once and applies every learning-loop update
-- in one transaction with row locks (port of the former multi-request JS logic).
CREATE OR REPLACE FUNCTION public.record_flight_outcome_tx(p_user uuid, p_intent uuid, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent record; v_outcome_id uuid; v_existing record;
  v_delay numeric := COALESCE((p->>'delay_minutes')::numeric, 0);
  v_actual numeric := COALESCE((p->>'actual_duration_minutes')::numeric, 0);
  v_planned numeric := (p->>'planned_duration_minutes')::numeric;
  v_pred numeric := (p->>'predicted_overall_score')::numeric;
  v_reroutes integer := COALESCE((p->>'reroute_count')::integer, 0);
  v_issues jsonb := COALESCE(p->'issues_encountered', '[]'::jsonb);
  v_arrival timestamptz := COALESCE((p->>'actual_arrival_time')::timestamptz, now());
  v_delta numeric; v_accuracy text;
  v_okey text; v_dkey text; v_band text;
  v_pat record; v_n integer; v_adj numeric; v_issue_adj numeric := 0; v_base numeric; v_adjusted numeric;
  v_syserr numeric := 0; v_cfg record; v_lr numeric; v_dir integer;
  v_high integer; v_total_issues integer;
BEGIN
  SELECT id, origin, destination, altitude_band INTO v_intent
  FROM flight_intents WHERE id = p_intent AND user_id = p_user;
  IF v_intent.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_delta := CASE WHEN v_planned IS NULL THEN 0 ELSE v_actual - v_planned END;
  v_accuracy := CASE WHEN v_delta > 5 THEN 'optimistic' WHEN v_delta < -5 THEN 'pessimistic' ELSE 'accurate' END;

  INSERT INTO flight_outcomes (
    flight_intent_id, aircraft_id, route_id, decision_id,
    planned_departure_time, actual_departure_time, planned_arrival_time, actual_arrival_time,
    planned_duration_minutes, actual_duration_minutes, delay_minutes,
    predicted_overall_score, predicted_weather_risk,
    experienced_max_wind_kmh, experienced_max_gusts_kmh, experienced_turbulence_probability,
    experienced_route_deviation_m, reroute_count, decision_accuracy, issues_encountered, completion_status, completed_at)
  VALUES (
    p_intent, p->>'aircraft_id',
    (SELECT id FROM routes WHERE id::text = p->>'route_id'),
    (SELECT id FROM flight_decisions WHERE id::text = p->>'decision_id'),
    (p->>'planned_departure_time')::timestamptz, (p->>'actual_departure_time')::timestamptz,
    (p->>'planned_arrival_time')::timestamptz, v_arrival,
    v_planned, v_actual, v_delay, v_pred, p->>'predicted_weather_risk',
    COALESCE((p->>'experienced_max_wind_kmh')::numeric, 0), COALESCE((p->>'experienced_max_gusts_kmh')::numeric, 0),
    COALESCE((p->>'experienced_turbulence_probability')::numeric, 0), COALESCE((p->>'experienced_route_deviation_m')::numeric, 0),
    v_reroutes, v_accuracy, v_issues, COALESCE(p->>'completion_status', 'completed'), now())
  ON CONFLICT (flight_intent_id) DO NOTHING
  RETURNING id INTO v_outcome_id;

  IF v_outcome_id IS NULL THEN
    SELECT id, decision_accuracy INTO v_existing FROM flight_outcomes WHERE flight_intent_id = p_intent;
    RETURN jsonb_build_object('outcome_id', v_existing.id, 'decision_accuracy', v_existing.decision_accuracy, 'already_recorded', true);
  END IF;

  UPDATE flight_intents SET status = 'landed', landed_at = v_arrival WHERE id = p_intent;

  v_okey := od_key(v_intent.origin); v_dkey := od_key(v_intent.destination);
  v_band := COALESCE(v_intent.altitude_band, 'low');
  SELECT COALESCE(SUM(CASE elem->>'severity' WHEN 'high' THEN -5 WHEN 'moderate' THEN -2 ELSE -0.5 END), 0),
         COUNT(*) FILTER (WHERE elem->>'severity' = 'high'), COUNT(*)
    INTO v_issue_adj, v_high, v_total_issues
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_issues) = 'array' THEN v_issues ELSE '[]'::jsonb END) elem;
  v_adj := 2 - LEAST(10, GREATEST(0, v_delay) * 0.5) + v_issue_adj - v_reroutes * 3;

  -- Fleet pattern
  SELECT * INTO v_pat FROM route_patterns
  WHERE origin_key = v_okey AND destination_key = v_dkey AND altitude_band = v_band AND user_id IS NULL
  FOR UPDATE;
  IF FOUND THEN
    v_n := COALESCE(v_pat.completed_flight_count, 0) + 1;
    v_base := COALESCE(v_pat.outcome_adjusted_score, v_pat.avg_overall_score, 70);
    v_adjusted := GREATEST(10, LEAST(100, v_base + v_adj));
    v_syserr := CASE WHEN v_pred IS NOT NULL
      THEN (COALESCE(v_pat.systematic_error, 0) * COALESCE(v_pat.completed_flight_count, 0) + (v_adjusted - v_pred)) / v_n
      ELSE COALESCE(v_pat.systematic_error, 0) END;
    UPDATE route_patterns SET
      completed_flight_count = v_n,
      avg_actual_delay_minutes = (COALESCE(avg_actual_delay_minutes, 0) * COALESCE(v_pat.completed_flight_count, 0) + v_delay) / v_n,
      avg_actual_duration_minutes = (COALESCE(avg_actual_duration_minutes, v_actual) * COALESCE(v_pat.completed_flight_count, 0) + v_actual) / v_n,
      outcome_adjusted_score = v_adjusted,
      systematic_error = v_syserr,
      last_updated = now()
    WHERE id = v_pat.id;
  END IF;

  -- User pattern
  SELECT * INTO v_pat FROM route_patterns
  WHERE origin_key = v_okey AND destination_key = v_dkey AND altitude_band = v_band AND user_id = p_user
  FOR UPDATE;
  IF FOUND THEN
    v_n := COALESCE(v_pat.completed_flight_count, 0) + 1;
    UPDATE route_patterns SET
      completed_flight_count = v_n,
      avg_actual_delay_minutes = (COALESCE(avg_actual_delay_minutes, 0) * COALESCE(v_pat.completed_flight_count, 0) + v_delay) / v_n,
      outcome_adjusted_score = GREATEST(10, LEAST(100, COALESCE(v_pat.outcome_adjusted_score, v_pat.avg_overall_score, 70) + v_adj)),
      last_updated = now()
    WHERE id = v_pat.id;
  END IF;

  -- Scoring-weight learning
  IF v_pred IS NOT NULL THEN
    SELECT * INTO v_cfg FROM route_score_config ORDER BY updated_at DESC NULLS LAST LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      v_lr := COALESCE(v_cfg.learning_rate, 0.05);
      v_dir := sign(v_syserr)::integer;
      IF v_dir <> 0 AND abs(v_syserr) > 3 THEN
        UPDATE route_score_config SET
          weight_safety     = GREATEST(0.05, LEAST(0.45, weight_safety + CASE WHEN v_dir < 0 THEN v_lr * 0.4 ELSE -v_lr * 0.2 END)),
          weight_time       = GREATEST(0.05, LEAST(0.45, COALESCE(weight_time, 0.20) + CASE WHEN v_dir < 0 THEN v_lr * 0.4 ELSE -v_lr * 0.2 END)),
          weight_efficiency = GREATEST(0.05, LEAST(0.45, weight_efficiency + CASE WHEN v_dir < 0 THEN -v_lr * 0.2 ELSE v_lr * 0.2 END)),
          weight_fuel       = GREATEST(0.05, LEAST(0.45, COALESCE(weight_fuel, 0.10) + CASE WHEN v_dir < 0 THEN -v_lr * 0.2 ELSE v_lr * 0.2 END)),
          total_outcomes_seen = COALESCE(total_outcomes_seen, 0) + 1,
          updated_at = now()
        WHERE id = v_cfg.id;
      ELSE
        UPDATE route_score_config SET total_outcomes_seen = COALESCE(total_outcomes_seen, 0) + 1, updated_at = now()
        WHERE id = v_cfg.id;
      END IF;
    END IF;
  END IF;

  -- Operator error profile (atomic upsert)
  INSERT INTO user_error_profiles AS up (user_id, total_flights, total_anomalies, high_severity_anomalies,
    avg_delay_minutes, reroute_rate, accuracy_accurate, accuracy_optimistic, accuracy_pessimistic,
    anomaly_rate, confidence_adjustment, last_updated)
  VALUES (p_user, 1, v_total_issues, v_high, v_delay, v_reroutes,
    (v_accuracy = 'accurate')::int, (v_accuracy = 'optimistic')::int, (v_accuracy = 'pessimistic')::int,
    v_total_issues, GREATEST(-20, -(v_total_issues * 20)), now())
  ON CONFLICT (user_id) DO UPDATE SET
    total_flights = up.total_flights + 1,
    total_anomalies = up.total_anomalies + EXCLUDED.total_anomalies,
    high_severity_anomalies = up.high_severity_anomalies + EXCLUDED.high_severity_anomalies,
    avg_delay_minutes = (up.avg_delay_minutes * up.total_flights + EXCLUDED.avg_delay_minutes) / (up.total_flights + 1),
    reroute_rate = (up.reroute_rate * up.total_flights + EXCLUDED.reroute_rate) / (up.total_flights + 1),
    accuracy_accurate = up.accuracy_accurate + EXCLUDED.accuracy_accurate,
    accuracy_optimistic = up.accuracy_optimistic + EXCLUDED.accuracy_optimistic,
    accuracy_pessimistic = up.accuracy_pessimistic + EXCLUDED.accuracy_pessimistic,
    anomaly_rate = (up.total_anomalies + EXCLUDED.total_anomalies)::numeric / (up.total_flights + 1),
    confidence_adjustment = GREATEST(-20, -((up.total_anomalies + EXCLUDED.total_anomalies)::numeric / (up.total_flights + 1) * 20)),
    last_updated = now();

  RETURN jsonb_build_object(
    'outcome_id', v_outcome_id,
    'decision_accuracy', v_accuracy,
    'duration_delta_minutes', round(v_delta, 1),
    'pattern_score_adjustment', round(v_adj, 2),
    'systematic_error', round(v_syserr, 2),
    'recorded_at', now());
END $$;

-- Set-based nightly refresh of fleet-wide patterns from the last 30 days of
-- routes (replaces the per-group query loop in background-analyzer). Keys use
-- od_key() — the old job keyed on the raw "name @ lat,lon" string, so its rows
-- never matched what the optimizer reads.
CREATE OR REPLACE FUNCTION public.refresh_fleet_route_patterns()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_groups integer; v_routes integer; v_avg_safety numeric; v_cfg record; v_adjust jsonb := '{}'::jsonb;
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

  SELECT count(*), avg(safety_score) INTO v_routes, v_avg_safety
  FROM routes WHERE created_at >= now() - interval '30 days' AND status = 'active';

  IF v_routes > 0 AND v_avg_safety < 70 THEN
    SELECT * INTO v_cfg FROM route_score_config ORDER BY updated_at DESC NULLS LAST LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE route_score_config SET
        weight_safety = LEAST(0.50, weight_safety + 0.02),
        weight_efficiency = GREATEST(0.05, weight_efficiency - 0.02),
        updated_at = now()
      WHERE id = v_cfg.id;
      v_adjust := jsonb_build_object('reason', format('avg_safety_score %s < 70 — increased safety weight', round(v_avg_safety)));
    END IF;
  END IF;

  RETURN jsonb_build_object('processed_routes', v_routes, 'updated_patterns', v_groups,
    'global_avg_safety', round(COALESCE(v_avg_safety, 100)), 'weight_adjustments', v_adjust, 'timestamp', now());
END $$;

-- ─── 5. Decision history ───────────────────────────────────────────────────
ALTER TABLE public.flight_decisions
  ADD COLUMN IF NOT EXISTS route_candidate_id text,
  ADD COLUMN IF NOT EXISTS superseded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inputs jsonb;

UPDATE public.flight_decisions d SET superseded = true
WHERE EXISTS (
  SELECT 1 FROM public.flight_decisions n
  WHERE n.flight_intent_id = d.flight_intent_id
    AND (COALESCE(n.created_at, 'epoch'), n.id) > (COALESCE(d.created_at, 'epoch'), d.id)
);
CREATE INDEX IF NOT EXISTS idx_flight_decisions_current
  ON public.flight_decisions (flight_intent_id) WHERE NOT superseded;

CREATE OR REPLACE FUNCTION public.supersede_previous_decisions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE flight_decisions SET superseded = true
  WHERE flight_intent_id = NEW.flight_intent_id AND id <> NEW.id AND NOT superseded;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_flight_decisions_supersede ON public.flight_decisions;
CREATE TRIGGER trg_flight_decisions_supersede
  AFTER INSERT ON public.flight_decisions
  FOR EACH ROW WHEN (NEW.flight_intent_id IS NOT NULL)
  EXECUTE FUNCTION public.supersede_previous_decisions();

-- ─── 6. Geocode cache ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.geocode_cache (
  query_norm   text PRIMARY KEY,
  lat          double precision,
  lon          double precision,
  display_name text,
  source       text NOT NULL,
  resolved_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.geocode_cache FROM anon, authenticated;

-- ─── 7. Observability ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.error_events (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL CHECK (source IN ('edge', 'client', 'db', 'cron')),
  fn          text,
  level       text NOT NULL DEFAULT 'error' CHECK (level IN ('warning', 'error', 'fatal')),
  message     text NOT NULL,
  context     jsonb,
  user_id     uuid
);
CREATE INDEX IF NOT EXISTS idx_error_events_time ON public.error_events (occurred_at DESC);
ALTER TABLE public.error_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.error_events FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.api_usage (
  day     date    NOT NULL DEFAULT current_date,
  service text    NOT NULL,
  calls   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, service)
);
ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_usage FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.api_budgets (
  service     text PRIMARY KEY,
  daily_limit integer NOT NULL,
  note        text
);
ALTER TABLE public.api_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_budgets FROM anon, authenticated;
INSERT INTO public.api_budgets (service, daily_limit, note) VALUES
  ('open-meteo', 8000, 'Free tier: 10,000 calls/day, non-commercial use only'),
  ('nominatim', 3000, 'OSM usage policy: max 1 req/s, no bulk geocoding'),
  ('edge-functions', 15000, 'Supabase Free: 500k invocations/month (~16k/day)')
ON CONFLICT (service) DO NOTHING;

CREATE OR REPLACE FUNCTION public.track_api_usage(p_service text, p_calls integer DEFAULT 1)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO api_usage (day, service, calls) VALUES (current_date, p_service, p_calls)
  ON CONFLICT (day, service) DO UPDATE SET calls = api_usage.calls + EXCLUDED.calls
$$;

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS app_private.settings (key text PRIMARY KEY, value text NOT NULL);
-- Owner sets: INSERT INTO app_private.settings VALUES ('alert_webhook_url', 'https://hooks.slack.com/...')
--             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE TABLE IF NOT EXISTS public.alert_events (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  dedupe_key   text NOT NULL UNIQUE,
  message      text NOT NULL,
  details      jsonb,
  delivered_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  last_request_id bigint,
  last_attempt_at timestamptz,
  last_error   text
);
ALTER TABLE public.alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.alert_events FROM anon, authenticated;

-- Raise alerts (deduplicated per window) and deliver/retry them via pg_net.
CREATE OR REPLACE FUNCTION public.check_alerts()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_errors integer; v_raised integer := 0; v_sent integer := 0; v_b record; v_used integer;
  v_url text; v_a record; v_resp record; v_req bigint;
  v_has_net boolean := to_regclass('net._http_response') IS NOT NULL;
BEGIN
  SELECT count(*) INTO v_errors FROM error_events
  WHERE occurred_at > now() - interval '15 minutes' AND level IN ('error', 'fatal');
  IF v_errors >= 10 THEN
    INSERT INTO alert_events (kind, dedupe_key, message, details)
    VALUES ('error_spike', 'error_spike:' || to_char(date_trunc('hour', now()), 'YYYY-MM-DD"T"HH24'),
            format('SHNAV: %s errors in the last 15 minutes', v_errors),
            (SELECT jsonb_agg(x) FROM (SELECT source, fn, count(*) AS n FROM error_events
              WHERE occurred_at > now() - interval '15 minutes' GROUP BY source, fn ORDER BY n DESC LIMIT 5) x))
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS v_raised = ROW_COUNT;
  END IF;

  FOR v_b IN SELECT * FROM api_budgets LOOP
    SELECT COALESCE(calls, 0) INTO v_used FROM api_usage WHERE day = current_date AND service = v_b.service;
    v_used := COALESCE(v_used, 0);
    IF v_used >= v_b.daily_limit THEN
      INSERT INTO alert_events (kind, dedupe_key, message, details)
      VALUES ('budget_exceeded', 'budget_exceeded:' || v_b.service || ':' || current_date,
              format('SHNAV: %s usage %s/%s today — budget exceeded', v_b.service, v_used, v_b.daily_limit),
              jsonb_build_object('service', v_b.service, 'used', v_used, 'limit', v_b.daily_limit, 'note', v_b.note))
      ON CONFLICT (dedupe_key) DO NOTHING;
    ELSIF v_used >= v_b.daily_limit * 0.8 THEN
      INSERT INTO alert_events (kind, dedupe_key, message, details)
      VALUES ('budget_warning', 'budget_warning:' || v_b.service || ':' || current_date,
              format('SHNAV: %s usage %s/%s today (80%% of budget)', v_b.service, v_used, v_b.daily_limit),
              jsonb_build_object('service', v_b.service, 'used', v_used, 'limit', v_b.daily_limit, 'note', v_b.note))
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;
  END LOOP;

  -- Delivery with retries (up to 5 attempts, ≥5 min apart).
  SELECT value INTO v_url FROM app_private.settings WHERE key = 'alert_webhook_url';
  IF v_url IS NOT NULL AND v_has_net THEN
    FOR v_a IN SELECT * FROM alert_events WHERE delivered_at IS NULL AND attempts < 5 ORDER BY id LOOP
      IF v_a.last_request_id IS NOT NULL THEN
        EXECUTE 'SELECT status_code, error_msg FROM net._http_response WHERE id = $1' INTO v_resp USING v_a.last_request_id;
        IF v_resp.status_code BETWEEN 200 AND 299 THEN
          UPDATE alert_events SET delivered_at = now(), last_error = NULL WHERE id = v_a.id;
          CONTINUE;
        END IF;
        IF v_resp IS NULL AND v_a.last_attempt_at > now() - interval '5 minutes' THEN
          CONTINUE; -- still in flight
        END IF;
        IF v_a.last_attempt_at > now() - interval '5 minutes' THEN CONTINUE; END IF;
      END IF;
      EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3)' INTO v_req
        USING v_url, jsonb_build_object('text', v_a.message, 'content', v_a.message),
              '{"Content-Type": "application/json"}'::jsonb;
      UPDATE alert_events SET attempts = attempts + 1, last_request_id = v_req, last_attempt_at = now(),
        last_error = CASE WHEN v_resp IS NOT NULL THEN COALESCE(v_resp.error_msg, 'HTTP ' || v_resp.status_code) END
      WHERE id = v_a.id;
      v_sent := v_sent + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('errors_15m', v_errors, 'alerts_raised', v_raised, 'deliveries_attempted', v_sent,
    'webhook_configured', v_url IS NOT NULL, 'pg_net', v_has_net);
END $$;

-- ─── Housekeeping jobs ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.expire_stale_intents()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH ex AS (
    UPDATE flight_intents SET status = 'expired', expired_at = now()
    WHERE (status IN ('analyzing', 'pending', 'approved')
           AND COALESCE(departure_end_at, created_at + interval '1 day') < now() - interval '30 minutes')
       OR (status IN ('in_air', 'active')
           AND COALESCE(departure_end_at, created_at) < now() - interval '12 hours')
    RETURNING id
  ), ts AS (
    UPDATE time_slots SET status = 'cancelled' WHERE flight_intent_id IN (SELECT id FROM ex) AND status <> 'cancelled'
  ), vs AS (
    UPDATE vertiport_slots SET status = 'cancelled' WHERE flight_intent_id IN (SELECT id FROM ex) AND status <> 'cancelled'
  )
  SELECT count(*) INTO v_n FROM ex;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.prune_operational_data()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rl integer := 0; v_err integer; v_geo integer;
BEGIN
  IF to_regclass('public.rate_limits') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.rate_limits WHERE window_start < now() - interval ''1 day''';
    GET DIAGNOSTICS v_rl = ROW_COUNT;
  END IF;
  DELETE FROM error_events WHERE occurred_at < now() - interval '30 days';
  GET DIAGNOSTICS v_err = ROW_COUNT;
  DELETE FROM geocode_cache WHERE lat IS NULL AND resolved_at < now() - interval '1 day';
  GET DIAGNOSTICS v_geo = ROW_COUNT;
  RETURN jsonb_build_object('rate_limits', v_rl, 'error_events', v_err, 'geocode_negative', v_geo);
END $$;

-- Lock every function above down to the service role (cron runs as postgres).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'reserve_airspace_slot(uuid,text,text,timestamptz,integer,boolean)',
    'reserve_vertiport_slots(uuid,text,uuid,uuid,timestamptz,integer)',
    'upsert_route_pattern(uuid,text,text,text,numeric,numeric,numeric,numeric,numeric,jsonb)',
    'record_flight_outcome_tx(uuid,uuid,jsonb)',
    'refresh_fleet_route_patterns()',
    'track_api_usage(text,integer)',
    'check_alerts()',
    'expire_stale_intents()',
    'prune_operational_data()',
    'enforce_client_status_transition()',
    'supersede_previous_decisions()'
  ] LOOP
    -- Supabase's default privileges grant EXECUTE to anon/authenticated
    -- directly, so revoking from PUBLIC alone is NOT enough.
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- The 2026-10-19 rate limiter had the same gap: any API caller could invoke
-- check_rate_limit (SECURITY DEFINER) with another user's id and exhaust their quota.
DO $$ BEGIN
  IF to_regprocedure('public.check_rate_limit(uuid,text,integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) TO service_role;
  END IF;
END $$;

-- ─── 8. Real vertiports ────────────────────────────────────────────────────
ALTER TABLE public.vertiports
  ADD COLUMN IF NOT EXISTS faa_id text,
  ADD COLUMN IF NOT EXISTS capacity_source text NOT NULL DEFAULT 'configured';

-- Fictional seed rows (e.g. "Airport Vertiport North" sat in Times Square).
UPDATE public.vertiports SET is_active = false, updated_at = now()
WHERE name IN ('Downtown Vertiport', 'Airport Vertiport North', 'Bay Vertiport', 'Uptown Hub', 'East Corridor Hub');

-- FAA-registered sites; coordinates from FAA airport data. Hourly capacities are
-- CONFIGURED planning values (no public capacity data exists) — capacity_source says so.
INSERT INTO public.vertiports (name, city, lat, lon, max_departures_per_hour, max_arrivals_per_hour, pad_count, is_active, faa_id, capacity_source) VALUES
  ('Downtown Manhattan Heliport',   'New York, NY', 40.7012, -74.0091, 6, 6, 3, true, 'JRB', 'configured'),
  ('East 34th Street Heliport',     'New York, NY', 40.7425, -73.9719, 4, 4, 2, true, '6N5', 'configured'),
  ('West 30th Street Heliport',     'New York, NY', 40.7545, -74.0071, 4, 4, 2, true, 'JRA', 'configured'),
  ('John F. Kennedy Intl (KJFK)',   'Queens, NY',   40.6413, -73.7781, 8, 8, 4, true, 'JFK', 'configured'),
  ('LaGuardia (KLGA)',              'Queens, NY',   40.7769, -73.8740, 6, 6, 3, true, 'LGA', 'configured'),
  ('Newark Liberty Intl (KEWR)',    'Newark, NJ',   40.6895, -74.1745, 8, 8, 4, true, 'EWR', 'configured')
ON CONFLICT (name) DO UPDATE SET
  lat = EXCLUDED.lat, lon = EXCLUDED.lon, faa_id = EXCLUDED.faa_id,
  capacity_source = EXCLUDED.capacity_source, is_active = true, updated_at = now();

-- ─── 9. Background jobs ────────────────────────────────────────────────────
DO $$ BEGIN
  BEGIN CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_cron unavailable (%); jobs not scheduled', SQLERRM; END;
  BEGIN CREATE EXTENSION IF NOT EXISTS pg_net;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_net unavailable (%); alerts recorded but not delivered', SQLERRM; END;
END $$;

DO $$
DECLARE j text;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'cron schema absent — skipping job scheduling';
    RETURN;
  END IF;
  FOREACH j IN ARRAY ARRAY['shnav-expire-stale-intents', 'shnav-prune', 'shnav-refresh-patterns', 'shnav-check-alerts'] LOOP
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = j;
  END LOOP;
  PERFORM cron.schedule('shnav-expire-stale-intents', '*/5 * * * *',  'SELECT public.expire_stale_intents()');
  PERFORM cron.schedule('shnav-prune',                '7 * * * *',    'SELECT public.prune_operational_data()');
  PERFORM cron.schedule('shnav-refresh-patterns',     '15 3 * * *',   'SELECT public.refresh_fleet_route_patterns()');
  PERFORM cron.schedule('shnav-check-alerts',         '*/5 * * * *',  'SELECT public.check_alerts()');
END $$;
