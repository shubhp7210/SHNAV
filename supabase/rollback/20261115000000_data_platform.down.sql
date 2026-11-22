-- Rollback for 20261115000000_data_platform.sql
-- Run AFTER redeploying the previous edge-function version, then:
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261115000000';
-- Data notes: observation stores, telemetry, past_flights, corrections, model
-- parameters and pattern flags are DROPPED. Export them first if needed
-- (scripts/audit-data.mjs --export). The archive_20261115 schema is restored
-- into route_patterns / user_error_profiles and then kept for reference.

DO $$ DECLARE j text; BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    FOREACH j IN ARRAY ARRAY['shnav-ingest-dispatch', 'shnav-finalize-flights', 'shnav-pair-verification',
                             'shnav-reconcile', 'shnav-learning-cycle', 'shnav-integrity', 'shnav-prune-ingest'] LOOP
      PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = j;
    END LOOP;
  END IF;
END $$;

-- Flights archived by this migration go back to "archived" semantics of the
-- old trigger (they stay archived; historical_flights still holds old copies).

DROP FUNCTION IF EXISTS public.dispatch_ingest();
DROP FUNCTION IF EXISTS public.prune_ingest_data();
DROP FUNCTION IF EXISTS public.run_integrity_checks();
DROP FUNCTION IF EXISTS public.run_learning_cycle(timestamptz);
DROP FUNCTION IF EXISTS public.respond_pattern_flag(uuid, text, text);
DROP FUNCTION IF EXISTS public.detect_user_patterns(timestamptz);
DROP FUNCTION IF EXISTS public.upsert_pattern_flag(uuid, text, boolean, text, jsonb, integer, numeric);
DROP FUNCTION IF EXISTS public.train_route_stats(timestamptz);
DROP FUNCTION IF EXISTS public.train_wind_bias(timestamptz, integer);
DROP FUNCTION IF EXISTS public.train_duration_calibration(timestamptz, integer);
DROP FUNCTION IF EXISTS public.promote_or_reject(text, jsonb, timestamptz, integer, integer, jsonb, boolean, text);
DROP FUNCTION IF EXISTS public.training_flights(timestamptz);
DROP FUNCTION IF EXISTS public.reconcile_past_flights(integer);
DROP FUNCTION IF EXISTS public.reconcile_past_flight(uuid);
DROP FUNCTION IF EXISTS public.finalize_ended_flights(integer);
DROP FUNCTION IF EXISTS public.finalize_flight(uuid, boolean);
DROP FUNCTION IF EXISTS public.apply_correction(text, uuid, text, jsonb, text, jsonb, text);
DROP FUNCTION IF EXISTS public.active_model_params();
DROP FUNCTION IF EXISTS public.ingest_telemetry(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.try_timestamptz(text);
DROP FUNCTION IF EXISTS public.observed_risk_level(numeric, numeric, numeric, text);
DROP FUNCTION IF EXISTS public.nearest_metar(double precision, double precision, timestamptz, double precision, interval);
DROP FUNCTION IF EXISTS public.pair_forecast_verification(integer);
DROP FUNCTION IF EXISTS public.withdraw_missing_restrictions(text, text[]);
DROP FUNCTION IF EXISTS public.budget_allows(text, integer);
DROP FUNCTION IF EXISTS public.ingest_due_sources();
DROP FUNCTION IF EXISTS public.has_active_operations();
DROP FUNCTION IF EXISTS public.ingest_finish(bigint, text, integer, integer, integer, integer, integer, text, text, text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.ingest_claim(text, boolean);

DROP VIEW IF EXISTS public.data_source_status;
DROP VIEW IF EXISTS public.airspace_restrictions_current;
DROP TABLE IF EXISTS public.integrity_check_results;
DROP TABLE IF EXISTS public.user_pattern_flags;
DROP TABLE IF EXISTS public.prediction_errors;
DROP TABLE IF EXISTS public.record_corrections;
ALTER TABLE IF EXISTS public.past_flights DISABLE TRIGGER trg_past_flights_guard;
DROP TABLE IF EXISTS public.past_flights;
DROP FUNCTION IF EXISTS public.guard_past_flights();
DROP TABLE IF EXISTS public.model_params;
DROP TABLE IF EXISTS public.flight_telemetry;
DROP TABLE IF EXISTS public.wx_verification;
DROP TABLE IF EXISTS public.wx_forecast_snapshots;
DROP TABLE IF EXISTS public.traffic_observations;
DROP TABLE IF EXISTS public.airspace_restrictions;
DROP TABLE IF EXISTS public.wx_advisories;
DROP TABLE IF EXISTS public.wx_taf;
DROP TABLE IF EXISTS public.wx_metar;
DROP TABLE IF EXISTS public.ingest_runs;
DROP TABLE IF EXISTS public.data_sources;
DELETE FROM public.api_budgets WHERE service IN ('awc', 'nws', 'faa-tfr', 'opensky');

ALTER TABLE public.routes DROP COLUMN IF EXISTS model_versions;
ALTER TABLE public.flight_decisions DROP COLUMN IF EXISTS model_versions;
ALTER TABLE public.flight_intents
  DROP COLUMN IF EXISTS telemetry_source, DROP COLUMN IF EXISTS last_telemetry_at,
  DROP COLUMN IF EXISTS telemetry_count, DROP COLUMN IF EXISTS in_air_at;
DROP FUNCTION IF EXISTS public.dist_to_polyline_m(double precision, double precision, jsonb);
DROP FUNCTION IF EXISTS public.geo_dist_m(double precision, double precision, double precision, double precision);

-- Restore learned state from the archive.
DO $$ BEGIN
  IF to_regclass('archive_20261115.route_patterns') IS NOT NULL THEN
    UPDATE public.route_patterns rp SET
      completed_flight_count = a.completed_flight_count, avg_actual_delay_minutes = a.avg_actual_delay_minutes,
      avg_actual_duration_minutes = a.avg_actual_duration_minutes, outcome_adjusted_score = a.outcome_adjusted_score,
      systematic_error = a.systematic_error
    FROM archive_20261115.route_patterns a WHERE a.id = rp.id;
  END IF;
  IF to_regclass('archive_20261115.user_error_profiles') IS NOT NULL THEN
    INSERT INTO public.user_error_profiles SELECT * FROM archive_20261115.user_error_profiles ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Previous archive trigger (copied landed flights into historical_flights).
CREATE OR REPLACE FUNCTION public.archive_landed_flight()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('landed', 'archived') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW.landed_at IS NULL THEN NEW.landed_at := now(); END IF;
    NEW.archived_at := now();
    INSERT INTO public.historical_flights(
      flight_intent_id, user_id, aircraft_id, operator_name, origin, destination,
      scheduled_departure, departure_window_start, departure_window_end,
      trajectory_score, weather_risk, conflicts, selected_clearance, final_status, landed_at, archived_at
    ) VALUES (
      NEW.id, NEW.user_id, NEW.aircraft_id, NEW.operator_name, NEW.origin, NEW.destination,
      NEW.scheduled_departure, NEW.departure_window_start, NEW.departure_window_end,
      COALESCE(NEW.trajectory_score, 0), NEW.weather_risk, COALESCE(NEW.conflicts, 0), NEW.selected_clearance,
      'archived', NEW.landed_at, NEW.archived_at
    ) ON CONFLICT (flight_intent_id) DO NOTHING;
    NEW.status := 'archived';
  END IF;
  RETURN NEW;
END;
$$;

-- FINAL STEP (required): re-run supabase/migrations/20261102000000_production_readiness.sql
-- (it is idempotent) to restore the previous record_flight_outcome_tx and
-- refresh_fleet_route_patterns bodies. supabase/tests/sql.test.mjs does exactly this.
