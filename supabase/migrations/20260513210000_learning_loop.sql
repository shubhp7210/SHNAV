-- ============================================================================
-- Continuous-learning loop schema
-- ============================================================================
-- Stores actual flight outcomes (delays, deviations, hazards encountered) and
-- the columns needed for the route-optimizer to bias future recommendations
-- toward routes that performed well historically. Also extends route_score_config
-- with time/fuel weights and a learning-rate so the self-correction loop has
-- everything it needs in one place.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. flight_outcomes — one row per completed flight.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.flight_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_intent_id UUID NOT NULL REFERENCES public.flight_intents(id) ON DELETE CASCADE,
  aircraft_id TEXT NOT NULL,
  route_id UUID REFERENCES public.routes(id) ON DELETE SET NULL,
  decision_id UUID REFERENCES public.flight_decisions(id) ON DELETE SET NULL,

  -- Timing
  planned_departure_time TIMESTAMPTZ,
  actual_departure_time TIMESTAMPTZ,
  planned_arrival_time TIMESTAMPTZ,
  actual_arrival_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  planned_duration_minutes NUMERIC,
  actual_duration_minutes NUMERIC NOT NULL DEFAULT 0,
  delay_minutes NUMERIC NOT NULL DEFAULT 0,

  -- Predicted vs experienced
  predicted_overall_score NUMERIC,
  predicted_weather_risk TEXT,
  experienced_max_wind_kmh NUMERIC,
  experienced_max_gusts_kmh NUMERIC,
  experienced_turbulence_probability NUMERIC,
  experienced_route_deviation_m NUMERIC,
  reroute_count INTEGER NOT NULL DEFAULT 0,

  -- Classification + free-form notes
  decision_accuracy TEXT CHECK (decision_accuracy IN ('accurate', 'optimistic', 'pessimistic')),
  issues_encountered JSONB,
  completion_status TEXT NOT NULL DEFAULT 'completed'
    CHECK (completion_status IN ('completed', 'aborted', 'diverted')),

  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flight_intent_id)
);

ALTER TABLE public.flight_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own flight_outcomes"
  ON public.flight_outcomes FOR SELECT
  USING (
    flight_intent_id IN (
      SELECT id FROM public.flight_intents WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Service can manage flight_outcomes"
  ON public.flight_outcomes FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_flight_outcomes_intent ON public.flight_outcomes(flight_intent_id);
CREATE INDEX IF NOT EXISTS idx_flight_outcomes_completed ON public.flight_outcomes(completed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. route_patterns — add columns for outcome-based learning.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.route_patterns
  ADD COLUMN IF NOT EXISTS completed_flight_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_actual_delay_minutes NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_actual_duration_minutes NUMERIC,
  ADD COLUMN IF NOT EXISTS outcome_adjusted_score NUMERIC,
  ADD COLUMN IF NOT EXISTS systematic_error NUMERIC NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. route_score_config — extend with time/fuel weights + learning-rate.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.route_score_config
  ADD COLUMN IF NOT EXISTS weight_time NUMERIC NOT NULL DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS weight_fuel NUMERIC NOT NULL DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS learning_rate NUMERIC NOT NULL DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS total_outcomes_seen INTEGER NOT NULL DEFAULT 0;

-- Rebalance the existing row so the new weight set sums to ~1.
UPDATE public.route_score_config
SET
  weight_safety     = 0.22,
  weight_weather    = 0.18,
  weight_traffic    = 0.15,
  weight_efficiency = 0.15,
  weight_time       = 0.20,
  weight_fuel       = 0.10,
  updated_at        = now()
WHERE weight_safety + weight_weather + weight_traffic + weight_efficiency NOT BETWEEN 0.98 AND 1.02;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. historical_flights — add the outcome fields the AI consumes
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.historical_flights
  ADD COLUMN IF NOT EXISTS actual_duration_minutes NUMERIC,
  ADD COLUMN IF NOT EXISTS planned_duration_minutes NUMERIC,
  ADD COLUMN IF NOT EXISTS delay_minutes NUMERIC,
  ADD COLUMN IF NOT EXISTS decision_accuracy TEXT,
  ADD COLUMN IF NOT EXISTS outcome_id UUID REFERENCES public.flight_outcomes(id) ON DELETE SET NULL;
