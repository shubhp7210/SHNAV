// HTTP fetch with timeouts, bounded retries (network errors, 5xx, short 429s),
// conditional requests (ETag / Last-Modified) and per-call usage metering.
import { countCall } from "../log.ts";

export const USER_AGENT = "SHNAV-research/1.0 (UAM simulation; non-commercial)";

export class IngestHttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryAfterS: number | null = null) {
    super(message);
  }
}

export interface FetchOut {
  status: number; text: string | null; notModified: boolean;
  etag: string | null; lastModified: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry-After as seconds (delta-seconds or HTTP date). */
export function parseRetryAfter(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 1000)) : null;
}

export async function fetchWithRetry(url: string, opts: {
  service: string; headers?: Record<string, string>; etag?: string | null; lastModified?: string | null;
  attempts?: number; timeoutMs?: number;
}): Promise<FetchOut> {
  const attempts = opts.attempts ?? 3;
  let lastErr: IngestHttpError | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(500 * 3 ** (i - 1) + Math.random() * 250);
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json, application/xml;q=0.9, */*;q=0.8", ...opts.headers };
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;
    countCall(opts.service);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch (e) {
      lastErr = new IngestHttpError(`network: ${e instanceof Error ? e.message : String(e)}`, null);
      continue;
    }
    if (res.status === 304) {
      await res.body?.cancel();
      return { status: 304, text: null, notModified: true, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
    }
    if (res.ok) {
      return { status: res.status, text: await res.text(), notModified: false,
        etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
    }
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    await res.body?.cancel();
    lastErr = new IngestHttpError(`HTTP ${res.status}`, res.status, retryAfter);
    // 429 with a long wait, or any 4xx: do not hammer — let the scheduler back off.
    if (res.status === 429 && (retryAfter == null || retryAfter > 10)) break;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    if (res.status === 429 && retryAfter != null) await sleep(retryAfter * 1000);
  }
  throw lastErr ?? new IngestHttpError("unknown fetch failure", null);
}

/** SHA-256 hex of a value's stable JSON form (dedupe key for observations). */
export async function contentHash(value: unknown): Promise<string> {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
      : v;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(stable(value))));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
