-- Security hardening from the Supabase Security Advisor (2026-11-22).
-- Rollback: supabase/rollback/20261122000100_security_hardening.down.sql
--
-- 1. data_source_status was a SECURITY DEFINER view (advisor ERROR): it ran with its owner's rights.
--    It now runs with the caller's rights. Signed-in users get read access to only the harmless
--    columns of data_sources (no URL, ETag, last_error, lease/backoff internals).
-- 2. Eight functions had no fixed search_path (advisor WARN): pin them to public.
--
-- Deliberately unchanged (reviewed):
--   • respond_pattern_flag — SECURITY DEFINER callable by signed-in users on purpose; it only
--     updates rows where user_id = auth.uid().
--   • pg_net lives in schema public — the extension cannot be relocated safely in place.
--   • "RLS enabled, no policy" notices — those tables are private by design (service role only).

-- ─── 1. data_source_status: caller's rights ─────────────────────────────────
DO $$ BEGIN
  IF to_regclass('public.data_sources') IS NOT NULL THEN
    REVOKE ALL ON public.data_sources FROM anon, authenticated;
    GRANT SELECT (id, name, kind, cadence_seconds, reliability, run_condition, enabled, licence,
                  last_success_at, last_data_at, consecutive_failures)
      ON public.data_sources TO authenticated;
    DROP POLICY IF EXISTS "Signed-in users read source status" ON public.data_sources;
    CREATE POLICY "Signed-in users read source status" ON public.data_sources
      FOR SELECT TO authenticated USING (true);
  END IF;
  IF to_regclass('public.data_source_status') IS NOT NULL THEN
    ALTER VIEW public.data_source_status SET (security_invoker = true);
  END IF;
END $$;

-- ─── 2. Fixed search_path ───────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.intent_is_live(text)',
    'public.od_key(text)',
    'public.enforce_client_status_transition()',
    'public.geo_dist_m(double precision, double precision, double precision, double precision)',
    'public.dist_to_polyline_m(double precision, double precision, jsonb)',
    'public.observed_risk_level(numeric, numeric, numeric, text)',
    'public.try_timestamptz(text)',
    'public.guard_past_flights()'
  ] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', f);
    END IF;
  END LOOP;
END $$;
