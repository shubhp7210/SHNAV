// Local-time helpers for the flight planner.

/** Today's date in the user's timezone. (toISOString() gives the UTC date,
 *  which is already "tomorrow" on a New York evening.) */
export function localDateISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local wall-clock date + "HH:MM" → absolute ISO instant (UTC, with "Z"). */
export function localInstant(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00`).toISOString();
}
