-- Per-user API rate limiting (cost/abuse protection for edge functions that call
-- paid/external APIs or run expensive compute). Backed by Postgres because edge
-- functions are stateless and distributed, so in-memory counters are unreliable.
--
-- Fixed-window counter: one row per (user, bucket, window). check_rate_limit()
-- atomically increments and reports whether the caller is still under the limit.

create table if not exists public.rate_limits (
  user_id      uuid        not null,
  bucket       text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (user_id, bucket, window_start)
);

-- Supports the cleanup delete below and keeps lookups cheap.
create index if not exists rate_limits_window_start_idx
  on public.rate_limits (window_start);

-- Only the service role (edge functions) ever touches this table. Enable RLS with
-- no policies so anon/authenticated clients are fully denied; service_role bypasses RLS.
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

-- Atomic fixed-window limiter. Returns true when the call is allowed (i.e. the
-- post-increment count for the current window is still <= p_limit).
create or replace function public.check_rate_limit(
  p_user_id        uuid,
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  -- Align to the start of the current fixed window.
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits (user_id, bucket, window_start, count)
       values (p_user_id, p_bucket, v_window_start, 1)
  on conflict (user_id, bucket, window_start)
    do update set count = public.rate_limits.count + 1
    returning count into v_count;

  -- Opportunistic cleanup of windows older than a day (cheap; bounded by index).
  delete from public.rate_limits
   where window_start < now() - interval '1 day';

  return v_count <= p_limit;
end;
$$;

-- Lock the function down to the service role only.
revoke all on function public.check_rate_limit(uuid, text, integer, integer) from public;
grant execute on function public.check_rate_limit(uuid, text, integer, integer) to service_role;
