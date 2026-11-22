-- Rollback for 20261122000000_admin_tracking.sql.
-- Roll the `ping` edge function back (or delete it) FIRST: it calls tracker_ping().
-- WARNING: drops tracker devices, tracker flights and their pings.
DROP FUNCTION IF EXISTS public.tracker_ping(text, double precision, double precision, double precision,
  double precision, double precision, double precision, timestamptz);

DO $$
DECLARE t text;
BEGIN
  IF to_regclass('public.flight_telemetry') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS flight_telemetry_source ON public.flight_telemetry;
    ALTER TABLE public.flight_telemetry DROP CONSTRAINT IF EXISTS flight_telemetry_source_check;
    ALTER TABLE public.flight_telemetry DROP COLUMN IF EXISTS source;
  END IF;
  -- flight_intents / flight_telemetry stay in the publication: harmless, and the site may rely on them.
  FOREACH t IN ARRAY ARRAY['flights', 'location_pings'] LOOP
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
  IF to_regclass('public.flight_intents') IS NOT NULL THEN
    DROP POLICY IF EXISTS "admin reads intents" ON public.flight_intents;
  END IF;
  IF to_regclass('public.past_flights') IS NOT NULL THEN
    DROP POLICY IF EXISTS "admin reads past flights" ON public.past_flights;
  END IF;
  IF to_regclass('public.flight_telemetry') IS NOT NULL THEN
    DROP POLICY IF EXISTS "admin reads telemetry" ON public.flight_telemetry;
  END IF;
END $$;

DROP TABLE IF EXISTS public.location_pings;
DROP TABLE IF EXISTS public.flights;
DROP TABLE IF EXISTS public.vehicles;
DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.set_telemetry_source();
DROP TABLE IF EXISTS public.admins;
