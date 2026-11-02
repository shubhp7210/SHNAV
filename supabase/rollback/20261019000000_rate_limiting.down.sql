-- Rollback for 20261019000000_rate_limiting.sql. Rate limiting fails OPEN in the
-- edge functions when this function is missing, so dropping it disables limits.
DROP FUNCTION IF EXISTS public.check_rate_limit(uuid, text, integer, integer);
DROP TABLE IF EXISTS public.rate_limits;
