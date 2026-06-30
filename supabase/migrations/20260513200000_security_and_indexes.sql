-- ============================================================================
-- Security hardening + performance indexes
-- ============================================================================
-- This migration:
--   1. Tightens RLS policies that were `USING (true)` (publicly mutable) so
--      anonymous and authenticated clients can no longer corrupt safety-
--      critical ATM data. Service-role keys (used by edge functions) bypass
--      RLS, so backend logic is unaffected.
--   2. Adds indexes on the columns most commonly used in WHERE / ORDER BY
--      to keep dashboard and conflict-detection queries fast as data grows.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Lock down write access on safety-critical tables.
--    Reads stay open (the dashboard needs them); writes become service-only.
-- ─────────────────────────────────────────────────────────────────────────

-- routes
DROP POLICY IF EXISTS "Anyone can insert routes"  ON public.routes;
DROP POLICY IF EXISTS "Anyone can update routes"  ON public.routes;
CREATE POLICY "Service can manage routes"
  ON public.routes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- route_patterns
DROP POLICY IF EXISTS "Anyone can insert route_patterns" ON public.route_patterns;
DROP POLICY IF EXISTS "Anyone can update route_patterns" ON public.route_patterns;
CREATE POLICY "Service can manage route_patterns"
  ON public.route_patterns FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- route_score_config (tuning weights — must be admin/service only)
DROP POLICY IF EXISTS "Anyone can insert route_score_config" ON public.route_score_config;
DROP POLICY IF EXISTS "Anyone can update route_score_config" ON public.route_score_config;
CREATE POLICY "Service can manage route_score_config"
  ON public.route_score_config FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- airspace_segments, time_slots, vertiports, vertiport_slots, flight_decisions,
-- trajectory_updates, anomalies already had `Service can manage ... FOR ALL USING (true)`.
-- Restrict them to service_role to ensure anon clients cannot write through them.
DROP POLICY IF EXISTS "Service can manage airspace_segments"  ON public.airspace_segments;
CREATE POLICY "Service can manage airspace_segments"
  ON public.airspace_segments FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service can manage time_slots" ON public.time_slots;
CREATE POLICY "Service can manage time_slots"
  ON public.time_slots FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service can manage vertiports" ON public.vertiports;
CREATE POLICY "Service can manage vertiports"
  ON public.vertiports FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service can manage vertiport_slots" ON public.vertiport_slots;
CREATE POLICY "Service can manage vertiport_slots"
  ON public.vertiport_slots FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service can manage flight_decisions" ON public.flight_decisions;
CREATE POLICY "Service can manage flight_decisions"
  ON public.flight_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service can manage trajectory_updates" ON public.trajectory_updates;
CREATE POLICY "Service can manage trajectory_updates"
  ON public.trajectory_updates FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service can manage anomalies" ON public.anomalies;
CREATE POLICY "Service can manage anomalies"
  ON public.anomalies FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Indexes on common query patterns.
--    `IF NOT EXISTS` keeps this idempotent across reruns.
-- ─────────────────────────────────────────────────────────────────────────

-- Dashboard query: WHERE status NOT IN (...) ORDER BY created_at DESC for a user
CREATE INDEX IF NOT EXISTS idx_flight_intents_user_status_created
  ON public.flight_intents (user_id, status, created_at DESC);

-- Conflict detection: status IN (...) + departure window range
CREATE INDEX IF NOT EXISTS idx_flight_intents_status
  ON public.flight_intents (status);
CREATE INDEX IF NOT EXISTS idx_flight_intents_dep_window
  ON public.flight_intents (departure_window_start, departure_window_end);

-- Foreign-key indexes (Postgres does NOT auto-index FKs)
CREATE INDEX IF NOT EXISTS idx_routes_flight_intent ON public.routes (flight_intent_id);
CREATE INDEX IF NOT EXISTS idx_time_slots_flight_intent ON public.time_slots (flight_intent_id);
CREATE INDEX IF NOT EXISTS idx_time_slots_segment ON public.time_slots (segment_id);
CREATE INDEX IF NOT EXISTS idx_vertiport_slots_flight_intent ON public.vertiport_slots (flight_intent_id);
CREATE INDEX IF NOT EXISTS idx_vertiport_slots_vertiport ON public.vertiport_slots (vertiport_id);
CREATE INDEX IF NOT EXISTS idx_flight_decisions_flight_intent ON public.flight_decisions (flight_intent_id);
CREATE INDEX IF NOT EXISTS idx_flight_decisions_route ON public.flight_decisions (route_id);
CREATE INDEX IF NOT EXISTS idx_trajectory_updates_flight_intent ON public.trajectory_updates (flight_intent_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_flight_intent ON public.anomalies (flight_intent_id);

-- Trajectory updates are queried by recency
CREATE INDEX IF NOT EXISTS idx_trajectory_updates_recorded_at
  ON public.trajectory_updates (recorded_at DESC);

-- Active anomaly queries filter on is_active
CREATE INDEX IF NOT EXISTS idx_anomalies_active
  ON public.anomalies (is_active) WHERE is_active = true;

-- Route pattern lookups by OD pair
CREATE INDEX IF NOT EXISTS idx_route_patterns_od
  ON public.route_patterns (origin_key, destination_key);

-- Airspace segments queried by no-fly state
CREATE INDEX IF NOT EXISTS idx_airspace_segments_no_fly
  ON public.airspace_segments (is_no_fly) WHERE is_no_fly = false;
