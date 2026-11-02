// Departure-window validation (pure — unit-tested from the frontend vitest suite).
//
// The client sends absolute instants with an explicit UTC offset, e.g.
// "2026-11-02T15:00:00.000Z". The old payload ("2026-11-02T10:00:00", no offset)
// was parsed as UTC by the server — a 4–5 hour error for New York users.

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export const MAX_WINDOW_MIN = 10;
/** Departures this far in the past are still accepted (clock skew, slow forms). */
export const PAST_TOLERANCE_MIN = 15;
/** Open-Meteo forecasts reach 16 days; keep planning inside that horizon. */
export const MAX_AHEAD_DAYS = 14;

export interface DepartureWindow { start: Date; end: Date }

export function parseDepartureWindow(
  startRaw: unknown,
  endRaw: unknown,
  now: Date = new Date(),
): { ok: true; window: DepartureWindow } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const parse = (v: unknown, name: string): Date | null => {
    if (typeof v !== "string" || !ISO_WITH_OFFSET.test(v)) {
      errors.push(`${name}: must be an ISO-8601 timestamp with a UTC offset`);
      return null;
    }
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) { errors.push(`${name}: invalid date`); return null; }
    return d;
  };
  const start = parse(startRaw, "departure_start_at");
  const end = parse(endRaw, "departure_end_at");
  if (start && end) {
    const lenMin = (end.getTime() - start.getTime()) / 60_000;
    if (lenMin <= 0) errors.push("departure_end_at must be after departure_start_at");
    else if (lenMin > MAX_WINDOW_MIN) errors.push(`departure window cannot exceed ${MAX_WINDOW_MIN} minutes`);
    if (start.getTime() < now.getTime() - PAST_TOLERANCE_MIN * 60_000) errors.push("departure window is in the past");
    if (start.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) errors.push(`departure must be within ${MAX_AHEAD_DAYS} days`);
  }
  return errors.length || !start || !end ? { ok: false, errors } : { ok: true, window: { start, end } };
}

/** Absolute minutes since the Unix epoch — the time base for conflict checks,
 *  so flights on different DATES never collide (the old minutes-of-day base did). */
export const epochMinutes = (d: Date | string): number => Math.floor(new Date(d).getTime() / 60_000);
