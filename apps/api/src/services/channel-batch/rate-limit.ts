/**
 * W13.3 — Rate-limit detection for bulk-action item handlers.
 *
 * The per-item handlers in BulkActionService.processJob can throw
 * for many reasons; one of them is "the channel said 429."
 * Treating a 429 as a regular item failure is wrong — the SKU
 * itself isn't broken, the upstream is just throttled. Marking
 * the item FAILED + moving on burns the rest of the job's
 * SKUs against an already-throttled channel.
 *
 * This module provides:
 *   - RateLimitError: a typed throw the handlers can use
 *   - isRateLimitError(): structural + string-pattern detector
 *     that catches both typed and string-only paths (for handlers
 *     that don't have access to the typed throw at write time).
 *   - extractRetryAfterMs(): pulls a backoff hint out of the
 *     error body / headers when the channel provides one.
 *
 * processJob's per-item catch then chooses to *pause* the loop
 * for retryAfterMs (or a default backoff ladder) and *retry the
 * same item* rather than marking it FAILED.
 */

export class RateLimitError extends Error {
  readonly isRateLimit = true
  constructor(
    message: string,
    public readonly retryAfterMs: number | null = null,
    public readonly channel: string | null = null,
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/**
 * Detects rate-limit shaped errors. Honors:
 *   - direct RateLimitError instances
 *   - errors whose message includes "429", "rate limit",
 *     "throttled", or "too many requests" (case-insensitive)
 *   - errors that carry a `status` / `statusCode` of 429
 */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown; isRateLimit?: unknown }
  if (e.isRateLimit === true) return true
  if (e.status === 429 || e.statusCode === 429) return true
  if (typeof e.message === 'string') {
    const m = e.message.toLowerCase()
    if (
      m.includes('http 429') ||
      m.includes('429 ') ||
      m.includes('rate limit') ||
      m.includes('throttled') ||
      m.includes('too many requests')
    ) {
      return true
    }
  }
  return false
}

/** Pulls a numeric "retry after" hint (ms) from the error if present.
 *  Recognises:
 *   - RateLimitError.retryAfterMs (typed path)
 *   - error.retryAfter (seconds — common in node-fetch responses)
 *   - error.headers['retry-after'] (HTTP header) */
export function extractRetryAfterMs(err: unknown): number | null {
  if (err instanceof RateLimitError) return err.retryAfterMs
  if (typeof err !== 'object' || err === null) return null
  const e = err as Record<string, any>
  if (typeof e.retryAfterMs === 'number') return e.retryAfterMs
  if (typeof e.retryAfter === 'number') return e.retryAfter * 1000
  const headers = e.headers
  if (headers && typeof headers === 'object') {
    const h =
      typeof headers.get === 'function'
        ? headers.get('retry-after')
        : headers['retry-after']
    if (typeof h === 'string') {
      const n = Number(h)
      if (Number.isFinite(n) && n > 0) return n * 1000
    }
  }
  return null
}

/**
 * Backoff ladder for rate-limit retries when the channel didn't
 * provide a hint. Caller passes the attempt number (1-indexed)
 * and gets back a sane ms delay capped at 30s.
 *
 *   1 → 1s, 2 → 2s, 3 → 4s, 4 → 8s, 5 → 16s, 6+ → 30s
 */
export function defaultRateLimitBackoffMs(attempt: number): number {
  if (attempt < 1) return 1000
  return Math.min(30_000, 1000 * Math.pow(2, attempt - 1))
}
