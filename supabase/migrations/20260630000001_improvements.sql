-- ============================================================================
-- Improvements: per-user ML patterns, user error profiles, airspace zones
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. route_patterns: add user_id for per-user pattern learning.
--    Fleet-wide rows keep user_id = NULL. User-specific rows use the user's id.
--    The existing single UNIQUE constraint is replaced with two partial indexes
--    because PostgreSQL treats NULL != NULL in unique constraints.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.route_patterns
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Drop the original composite unique constraint (auto-named by Postgres).
ALTER TABLE public.route_patterns
  DROP CONSTRAINT IF EXISTS route_patterns_origin_key_destination_key_altitude_band_key;

-- Fleet-wide patterns (user_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS route_patterns_fleet_unique
  ON public.route_patterns (origin_key, destination_key, altitude_band)
  WHERE user_id IS NULL;

-- Per-user patterns
CREATE UNIQUE INDEX IF NOT EXISTS route_patterns_user_unique
  ON public.route_patterns (user_id, origin_key, destination_key, altitude_band)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_route_patterns_user
  ON public.route_patterns (user_id, origin_key, destination_key);

-- Update RLS: authenticated users can see fleet-wide patterns + their own.
DROP POLICY IF EXISTS "Authenticated users read route_patterns" ON public.route_patterns;
CREATE POLICY "Authenticated users read route_patterns"
  ON public.route_patterns FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND (user_id IS NULL OR user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_error_profiles: per-user anomaly/accuracy history for confidence
--    scoring in the flight-decision-engine.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_error_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  total_flights INTEGER NOT NULL DEFAULT 0,
  total_anomalies INTEGER NOT NULL DEFAULT 0,
  high_severity_anomalies INTEGER NOT NULL DEFAULT 0,
  avg_delay_minutes NUMERIC NOT NULL DEFAULT 0,
  reroute_rate NUMERIC NOT NULL DEFAULT 0,
  accuracy_accurate INTEGER NOT NULL DEFAULT 0,
  accuracy_optimistic INTEGER NOT NULL DEFAULT 0,
  accuracy_pessimistic INTEGER NOT NULL DEFAULT 0,
  anomaly_rate NUMERIC NOT NULL DEFAULT 0,
  -- Additive offset applied to base confidence in flight decisions.
  -- Negative = user history warrants more caution (cap at -20).
  confidence_adjustment NUMERIC NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_error_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own error profile"
  ON public.user_error_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service can manage user_error_profiles"
  ON public.user_error_profiles FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. airspace_segments: add boundary_polygon for spatial no-fly enforcement.
--    Stored as a JSONB array of {lat, lon} objects forming a closed polygon.
--    NULL = segment has no defined boundary (corridor-style, check by name only).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.airspace_segments
  ADD COLUMN IF NOT EXISTS boundary_polygon JSONB;
