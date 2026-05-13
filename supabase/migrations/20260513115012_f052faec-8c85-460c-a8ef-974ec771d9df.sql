
ALTER TABLE public.flight_intents
  ADD COLUMN IF NOT EXISTS scheduled_departure timestamptz,
  ADD COLUMN IF NOT EXISTS landed_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS public.historical_flights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_intent_id uuid NOT NULL UNIQUE,
  user_id uuid,
  aircraft_id text NOT NULL,
  operator_name text NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL,
  scheduled_departure timestamptz,
  departure_window_start text,
  departure_window_end text,
  trajectory_score integer DEFAULT 0,
  weather_risk text,
  conflicts integer DEFAULT 0,
  selected_clearance text,
  final_status text NOT NULL DEFAULT 'archived',
  landed_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.historical_flights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own historical flights" ON public.historical_flights;
CREATE POLICY "Users read own historical flights"
  ON public.historical_flights FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service can manage historical flights" ON public.historical_flights;
CREATE POLICY "Service can manage historical flights"
  ON public.historical_flights FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_historical_flights_user ON public.historical_flights(user_id, archived_at DESC);

CREATE OR REPLACE FUNCTION public.archive_landed_flight()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('landed', 'archived')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW.landed_at IS NULL THEN
      NEW.landed_at := now();
    END IF;
    NEW.archived_at := now();

    INSERT INTO public.historical_flights(
      flight_intent_id, user_id, aircraft_id, operator_name, origin, destination,
      scheduled_departure, departure_window_start, departure_window_end,
      trajectory_score, weather_risk, conflicts, selected_clearance,
      final_status, landed_at, archived_at
    ) VALUES (
      NEW.id, NEW.user_id, NEW.aircraft_id, NEW.operator_name, NEW.origin, NEW.destination,
      NEW.scheduled_departure, NEW.departure_window_start, NEW.departure_window_end,
      COALESCE(NEW.trajectory_score, 0), NEW.weather_risk, COALESCE(NEW.conflicts, 0), NEW.selected_clearance,
      'archived', NEW.landed_at, NEW.archived_at
    )
    ON CONFLICT (flight_intent_id) DO NOTHING;

    NEW.status := 'archived';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_flight_intents_archive ON public.flight_intents;
CREATE TRIGGER trg_flight_intents_archive
  BEFORE UPDATE ON public.flight_intents
  FOR EACH ROW EXECUTE FUNCTION public.archive_landed_flight();
