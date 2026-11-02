// Other operators' aircraft are shown as stable anonymous traffic labels, so
// fleet-wide conflicts can be reported without leaking registrations.

/** FNV-1a 32-bit — tiny, synchronous, stable across runtimes. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** e.g. "TFC-3FA2" — same flight id → same label. */
export function trafficLabel(flightId: string): string {
  return `TFC-${fnv1a(flightId).toString(16).toUpperCase().padStart(8, "0").slice(0, 4)}`;
}
