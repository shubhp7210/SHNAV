-- Rollback for 20261102000000_production_readiness.sql
-- Run in the SQL editor (or psql) AFTER redeploying the previous edge-function
-- version, then: DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261102000000';
-- Data notes: new columns/tables are dropped (their data is lost); deduplicated
-- slot rows are NOT restored; the fictional seed vertiports are re-activated.

DO $$ DECLARE j text; BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    FOREACH j IN ARRAY ARRAY['shnav-expire-stale-intents', 'shnav-prune', 'shnav-refresh-patterns', 'shnav-check-alerts'] LOOP
      PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = j;
    END LOOP;
  END IF;
END $$;

-- Vertiports
UPDATE public.vertiports SET is_active = false
WHERE faa_id IN ('JRB', '6N5', 'JRA', 'JFK', 'LGA', 'EWR')
  AND NOT EXISTS (SELECT 1 FROM public.vertiport_slots vs WHERE vs.vertiport_id = vertiports.id);
DELETE FROM public.vertiports
WHERE faa_id IN ('JRB', '6N5', 'JRA', 'JFK', 'LGA', 'EWR')
  AND NOT EXISTS (SELECT 1 FROM public.vertiport_slots vs WHERE vs.vertiport_id = vertiports.id);
UPDATE public.vertiports SET is_active = true
WHERE name IN ('Downtown Vertiport', 'Airport Vertiport North', 'Bay Vertiport', 'Uptown Hub', 'East Corridor Hub');
ALTER TABLE public.vertiports DROP COLUMN IF EXISTS faa_id, DROP COLUMN IF EXISTS capacity_source;

-- Functions
DROP FUNCTION IF EXISTS public.prune_operational_data();
DROP FUNCTION IF EXISTS public.expire_stale_intents();
DROP FUNCTION IF EXISTS public.check_alerts();
DROP FUNCTION IF EXISTS public.track_api_usage(text, integer);
DROP FUNCTION IF EXISTS public.refresh_fleet_route_patterns();
DROP FUNCTION IF EXISTS public.record_flight_outcome_tx(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.upsert_route_pattern(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, jsonb);
DROP FUNCTION IF EXISTS public.reserve_vertiport_slots(uuid, text, uuid, uuid, timestamptz, integer);
DROP FUNCTION IF EXISTS public.reserve_airspace_slot(uuid, text, text, timestamptz, integer, boolean);
DROP FUNCTION IF EXISTS public.intent_is_live(text);
DROP FUNCTION IF EXISTS public.od_key(text);

-- Observability
DROP TABLE IF EXISTS public.alert_events;
DROP TABLE IF EXISTS app_private.settings;
DROP SCHEMA IF EXISTS app_private;
DROP TABLE IF EXISTS public.api_budgets;
DROP TABLE IF EXISTS public.api_usage;
DROP TABLE IF EXISTS public.error_events;
DROP TABLE IF EXISTS public.geocode_cache;

-- Decisions
DROP TRIGGER IF EXISTS trg_flight_decisions_supersede ON public.flight_decisions;
DROP FUNCTION IF EXISTS public.supersede_previous_decisions();
DROP INDEX IF EXISTS public.idx_flight_decisions_current;
ALTER TABLE public.flight_decisions
  DROP COLUMN IF EXISTS route_candidate_id, DROP COLUMN IF EXISTS superseded, DROP COLUMN IF EXISTS inputs;

-- Reservations
DROP INDEX IF EXISTS public.idx_vertiport_slots_vp_type_time;
DROP INDEX IF EXISTS public.vertiport_slots_one_per_intent_type;
DROP INDEX IF EXISTS public.idx_time_slots_segment_start;
DROP INDEX IF EXISTS public.time_slots_one_per_intent;

-- Client write access (restore previous behaviour)
DROP TRIGGER IF EXISTS trg_flight_intents_aa_client_guard ON public.flight_intents;
DROP FUNCTION IF EXISTS public.enforce_client_status_transition();
GRANT INSERT, UPDATE, DELETE ON public.flight_intents TO authenticated;
DROP POLICY IF EXISTS "Users update own intents" ON public.flight_intents;
CREATE POLICY "Users update own intents" ON public.flight_intents FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users insert own intents" ON public.flight_intents FOR INSERT WITH CHECK (auth.uid() = user_id);

-- flight_intents columns
DROP INDEX IF EXISTS public.idx_flight_intents_status_departure;
DROP INDEX IF EXISTS public.flight_intents_idempotency_unique;
ALTER TABLE public.flight_intents
  DROP CONSTRAINT IF EXISTS flight_intents_departure_order_chk,
  DROP CONSTRAINT IF EXISTS flight_intents_coords_status_chk,
  DROP COLUMN IF EXISTS expired_at,
  DROP COLUMN IF EXISTS vertiport_assessment,
  DROP COLUMN IF EXISTS airspace_assessment,
  DROP COLUMN IF EXISTS analysis_result,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS coords_status,
  DROP COLUMN IF EXISTS dest_lon,
  DROP COLUMN IF EXISTS dest_lat,
  DROP COLUMN IF EXISTS origin_lon,
  DROP COLUMN IF EXISTS origin_lat,
  DROP COLUMN IF EXISTS departure_end_at,
  DROP COLUMN IF EXISTS departure_start_at;
-- Rows marked 'expired' by the cron job keep that status; set them back if needed:
-- UPDATE public.flight_intents SET status = 'pending' WHERE status = 'expired';
