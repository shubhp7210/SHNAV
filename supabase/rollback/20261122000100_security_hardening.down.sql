-- Rollback for 20261122000100_security_hardening.sql (restores the previous behaviour).
DO $$ BEGIN
  IF to_regclass('public.data_source_status') IS NOT NULL THEN
    ALTER VIEW public.data_source_status SET (security_invoker = false);
  END IF;
  IF to_regclass('public.data_sources') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Signed-in users read source status" ON public.data_sources;
    REVOKE ALL ON public.data_sources FROM authenticated;
  END IF;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.intent_is_live(text)', 'public.od_key(text)', 'public.enforce_client_status_transition()',
    'public.geo_dist_m(double precision, double precision, double precision, double precision)',
    'public.dist_to_polyline_m(double precision, double precision, jsonb)',
    'public.observed_risk_level(numeric, numeric, numeric, text)', 'public.try_timestamptz(text)',
    'public.guard_past_flights()'
  ] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN EXECUTE format('ALTER FUNCTION %s RESET search_path', f); END IF;
  END LOOP;
END $$;
