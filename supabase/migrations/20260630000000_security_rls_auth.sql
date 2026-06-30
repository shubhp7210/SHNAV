-- ============================================================================
-- Security hardening: lock down all public SELECT policies
-- ============================================================================
-- Phase 1 of security audit remediation.
-- Writes on all ATM tables were already locked to service_role in the
-- 20260513200000 migration. This migration closes the remaining gap:
-- all "Anyone can read X" SELECT policies are replaced with user-scoped
-- or auth-gated equivalents. Public infrastructure tables (airspace_segments,
-- vertiports) keep open reads — they are reference data, not operator data.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fix historical_flights — add TO service_role on the manage policy
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Service can manage historical flights" ON public.historical_flights;
CREATE POLICY "Service can manage historical flights"
  ON public.historical_flights FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. routes — scoped to owner via flight_intent_id → flight_intents.user_id
--    Routes without a flight_intent_id (orphaned) are invisible to all users.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read routes" ON public.routes;
CREATE POLICY "Users read own routes"
  ON public.routes FOR SELECT
  USING (
    flight_intent_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.flight_intents fi
      WHERE fi.id = routes.flight_intent_id
        AND fi.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. time_slots — scoped via flight_intent_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read time_slots" ON public.time_slots;
CREATE POLICY "Users read own time_slots"
  ON public.time_slots FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.flight_intents fi
      WHERE fi.id = time_slots.flight_intent_id
        AND fi.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. vertiport_slots — scoped via flight_intent_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read vertiport_slots" ON public.vertiport_slots;
CREATE POLICY "Users read own vertiport_slots"
  ON public.vertiport_slots FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.flight_intents fi
      WHERE fi.id = vertiport_slots.flight_intent_id
        AND fi.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. flight_decisions — scoped via flight_intent_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read flight_decisions" ON public.flight_decisions;
CREATE POLICY "Users read own flight_decisions"
  ON public.flight_decisions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.flight_intents fi
      WHERE fi.id = flight_decisions.flight_intent_id
        AND fi.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. trajectory_updates — scoped via flight_intent_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read trajectory_updates" ON public.trajectory_updates;
CREATE POLICY "Users read own trajectory_updates"
  ON public.trajectory_updates FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.flight_intents fi
      WHERE fi.id = trajectory_updates.flight_intent_id
        AND fi.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. anomalies — scoped via flight_intent_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read anomalies" ON public.anomalies;
CREATE POLICY "Users read own anomalies"
  ON public.anomalies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.flight_intents fi
      WHERE fi.id = anomalies.flight_intent_id
        AND fi.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. route_patterns — auth-gated (aggregate fleet data, not per-user sensitive)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read route_patterns" ON public.route_patterns;
CREATE POLICY "Authenticated users read route_patterns"
  ON public.route_patterns FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. route_score_config — auth-gated (system config, not public)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read route_score_config" ON public.route_score_config;
CREATE POLICY "Authenticated users read route_score_config"
  ON public.route_score_config FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Indexes to speed up the new EXISTS sub-queries
--     These join flight_intent_id → flight_intents.id which is already the PK,
--     but the RLS sub-queries benefit from explicit indexes on the FK columns.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_routes_fi_user
  ON public.routes (flight_intent_id);

-- The other FK indexes (time_slots, vertiport_slots, flight_decisions,
-- trajectory_updates, anomalies) were already created in 20260513200000.
