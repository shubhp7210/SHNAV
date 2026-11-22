-- Admin map + device trackers (2026-11-22).
--
-- What this adds:
--   • admins            — accounts allowed to use the private admin map (admin/index.html)
--   • vehicles          — tracker devices; each authenticates to the `ping` edge function
--                         with its secret device_token
--   • flights           — a tracker's own "session" (active → completed)
--   • location_pings    — every position a tracker reports
--   • tracker_ping()    — the single entry point the `ping` function calls. Besides logging
--                         the ping, if the vehicle is linked (owner_user_id + aircraft_id) to an
--                         airborne website flight of that owner, the fix is fed through
--                         ingest_telemetry(), so the tracker becomes real GPS telemetry for that
--                         flight (live position on the site, and it can make the flight verified).
--   • admin read access to the website's flight tables, for the admin map.
--
-- Parts of this were first applied to production by hand in the SQL editor. Everything here is
-- idempotent, so `supabase db push` re-applying it is harmless.
-- Rollback: supabase/rollback/20261122000000_admin_tracking.down.sql

-- ─── 1. Tables ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.vehicles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text,
  device_token text UNIQUE NOT NULL,
  created_at   timestamptz DEFAULT now()
);
-- Link a tracker to a website pilot + aircraft so its pings feed that pilot's live flight.
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS aircraft_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_device_token_length') THEN
    -- Existing rows are 64 hex chars; NOT VALID keeps the migration safe on unexpected legacy rows.
    ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_device_token_length CHECK (length(device_token) >= 32) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.flights (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES public.vehicles(id),
  user_id    uuid REFERENCES auth.users(id),
  status     text DEFAULT 'active',            -- 'active' | 'completed'
  started_at timestamptz DEFAULT now(),
  ended_at   timestamptz
);
CREATE INDEX IF NOT EXISTS flights_vehicle_active_idx ON public.flights (vehicle_id, started_at DESC) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.location_pings (
  id         bigserial PRIMARY KEY,
  flight_id  uuid REFERENCES public.flights(id),
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  altitude   double precision,
  speed      double precision,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS location_pings_flight_id_created_at_idx ON public.location_pings (flight_id, created_at DESC);

-- ─── 2. Privileges + RLS ────────────────────────────────────────────────────
-- Nothing here is for signed-out visitors. Signed-in users only get what RLS allows.
REVOKE ALL ON public.admins, public.vehicles, public.flights, public.location_pings FROM anon;
REVOKE ALL ON public.admins, public.vehicles, public.flights, public.location_pings FROM authenticated;
GRANT SELECT ON public.admins TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.vehicles, public.flights TO authenticated;
GRANT SELECT ON public.location_pings TO authenticated;

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_pings ENABLE ROW LEVEL SECURITY;

-- An admin request must come from (1) an account listed in admins, (2) whose session was opened
-- with a one-time email code (JWT "amr" method otp/magiclink — a password session from the main
-- site does NOT count), (3) within the last 24 hours. The admin site signs in with an email code.
-- SECURITY DEFINER so policies can consult admins without exposing it or recursing through its RLS.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH claims AS (
    SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) -> 'amr' AS amr
  )
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid())
     AND EXISTS (
       SELECT 1 FROM claims, jsonb_array_elements(CASE WHEN jsonb_typeof(claims.amr) = 'array' THEN claims.amr ELSE '[]'::jsonb END) AS a
       WHERE a->>'method' IN ('otp', 'magiclink')
         AND coalesce((a->>'timestamp')::bigint, 0) > extract(epoch FROM now()) - 86400)
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

DROP POLICY IF EXISTS "read own admin row" ON public.admins;
CREATE POLICY "read own admin row" ON public.admins FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "admin reads vehicles" ON public.vehicles;
CREATE POLICY "admin reads vehicles" ON public.vehicles FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "admin inserts vehicles" ON public.vehicles;
CREATE POLICY "admin inserts vehicles" ON public.vehicles FOR INSERT TO authenticated WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "admin updates vehicles" ON public.vehicles;
CREATE POLICY "admin updates vehicles" ON public.vehicles FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "admin reads flights" ON public.flights;
CREATE POLICY "admin reads flights" ON public.flights FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "admin inserts flights" ON public.flights;
CREATE POLICY "admin inserts flights" ON public.flights FOR INSERT TO authenticated WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "admin updates flights" ON public.flights;
CREATE POLICY "admin updates flights" ON public.flights FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "user reads own flight" ON public.flights;
CREATE POLICY "user reads own flight" ON public.flights FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "admin reads pings" ON public.location_pings;
CREATE POLICY "admin reads pings" ON public.location_pings FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "user reads own pings" ON public.location_pings;
CREATE POLICY "user reads own pings" ON public.location_pings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.flights f WHERE f.id = location_pings.flight_id AND f.user_id = auth.uid()));

-- Admin read access to the website's flight tables (added to the users' own-row policies, not replacing them).
-- Guarded: on a fresh database the data-platform tables may not exist yet when this runs.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['flight_intents', 'past_flights', 'flight_telemetry'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                     CASE t WHEN 'flight_intents' THEN 'admin reads intents'
                            WHEN 'past_flights'   THEN 'admin reads past flights'
                            ELSE 'admin reads telemetry' END, t);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_admin())',
                     CASE t WHEN 'flight_intents' THEN 'admin reads intents'
                            WHEN 'past_flights'   THEN 'admin reads past flights'
                            ELSE 'admin reads telemetry' END, t);
    END IF;
  END LOOP;
END $$;

-- ─── 3. Realtime (admin map + live views) ───────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['flights', 'location_pings', 'flight_intents', 'flight_telemetry'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ─── 4. Telemetry source: phone GPS vs tracker device ──────────────────────
-- The website shows the pilot a linked tracker's position live; it needs to tell those fixes apart
-- from its own phone GPS. tracker_ping() sets shnav.telemetry_source = 'tracker' for its transaction.
CREATE OR REPLACE FUNCTION public.set_telemetry_source()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.source := coalesce(nullif(current_setting('shnav.telemetry_source', true), ''), 'phone');
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF to_regclass('public.flight_telemetry') IS NOT NULL THEN
    ALTER TABLE public.flight_telemetry ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'phone';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flight_telemetry_source_check') THEN
      ALTER TABLE public.flight_telemetry ADD CONSTRAINT flight_telemetry_source_check CHECK (source IN ('phone', 'tracker'));
    END IF;
    DROP TRIGGER IF EXISTS flight_telemetry_source ON public.flight_telemetry;
    CREATE TRIGGER flight_telemetry_source BEFORE INSERT ON public.flight_telemetry
      FOR EACH ROW EXECUTE FUNCTION public.set_telemetry_source();
  END IF;
END $$;

-- ─── 5. tracker_ping(): one atomic entry point for devices ─────────────────
-- Called only by the `ping` edge function (service role). Returns jsonb:
--   { vehicle_id, tracker_flight_id|null, intent_id|null, telemetry|null }
--   or { error: 'bad_token' | 'bad_position' | 'rate_limited' | 'nothing_active' }
CREATE OR REPLACE FUNCTION public.tracker_ping(
  p_token text, p_lat double precision, p_lng double precision,
  p_alt double precision DEFAULT NULL, p_speed double precision DEFAULT NULL,
  p_heading double precision DEFAULT NULL, p_accuracy double precision DEFAULT NULL,
  p_t timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vehicle record; v_flight uuid; v_intent uuid; v_intent_user uuid; v_tel jsonb; v_t timestamptz;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 THEN RETURN jsonb_build_object('error', 'bad_token'); END IF;
  SELECT id, owner_user_id, aircraft_id INTO v_vehicle FROM vehicles WHERE device_token = p_token;
  IF v_vehicle.id IS NULL THEN RETURN jsonb_build_object('error', 'bad_token'); END IF;
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RETURN jsonb_build_object('error', 'bad_position');
  END IF;
  -- 2 pings/second sustained is plenty for a tracker; protects the tables from a runaway device.
  IF NOT check_rate_limit(v_vehicle.id, 'tracker-ping', 120, 60) THEN
    RETURN jsonb_build_object('error', 'rate_limited');
  END IF;
  -- Device clocks drift: never accept a fix from the future, and treat very old fixes as "now".
  v_t := CASE WHEN p_t IS NULL OR p_t > now() OR p_t < now() - interval '10 minutes' THEN now() ELSE p_t END;

  SELECT id INTO v_flight FROM flights
  WHERE vehicle_id = v_vehicle.id AND status = 'active' ORDER BY started_at DESC LIMIT 1;
  IF v_flight IS NOT NULL THEN
    INSERT INTO location_pings (flight_id, lat, lng, altitude, speed, created_at)
    VALUES (v_flight, p_lat, p_lng, p_alt, p_speed, v_t);
  END IF;

  -- Linked website flight: only the vehicle owner's own airborne flight with the same aircraft id.
  IF v_vehicle.owner_user_id IS NOT NULL AND nullif(trim(v_vehicle.aircraft_id), '') IS NOT NULL THEN
    SELECT id, user_id INTO v_intent, v_intent_user FROM flight_intents
    WHERE user_id = v_vehicle.owner_user_id
      AND upper(trim(aircraft_id)) = upper(trim(v_vehicle.aircraft_id))
      AND status IN ('in_air', 'active')
    ORDER BY coalesce(in_air_at, created_at) DESC LIMIT 1;
    IF v_intent IS NOT NULL THEN
      PERFORM set_config('shnav.telemetry_source', 'tracker', true);
      v_tel := ingest_telemetry(v_intent_user, v_intent, jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        't', to_char(v_t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'lat', p_lat, 'lon', p_lng, 'alt', p_alt, 'spd', p_speed, 'hdg', p_heading, 'acc', p_accuracy))));
    END IF;
  END IF;

  PERFORM set_config('shnav.telemetry_source', '', true);
  IF v_flight IS NULL AND v_intent IS NULL THEN
    RETURN jsonb_build_object('error', 'nothing_active', 'vehicle_id', v_vehicle.id);
  END IF;
  RETURN jsonb_build_object('vehicle_id', v_vehicle.id, 'tracker_flight_id', v_flight,
                            'intent_id', v_intent, 'telemetry', v_tel);
END $$;
REVOKE ALL ON FUNCTION public.tracker_ping(text, double precision, double precision, double precision,
  double precision, double precision, double precision, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracker_ping(text, double precision, double precision, double precision,
  double precision, double precision, double precision, timestamptz) TO service_role;
