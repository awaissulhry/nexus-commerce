/**
 * Editing correctness (group 3) — the Campaigns grid's one read, `GET /api/advertising/campaigns`. The API keeps this list
 * in a 300-s read cache (ads-campaign-list.service.ts); the flush after a write runs on the instance that took the write,
 * after its answer was sent, so a re-read soon after a save can still be served the list from before it. `fresh=1` reads
 * past the cache: on "Refresh view", and on every read while this screen's own last write is younger than the cache.
 * Pure, tested in Node.
 */

/** How long the API may serve this list from its read cache (ads-campaign-list.service.ts `cached(…, 300, …)`). */
export const LIST_CACHE_MS = 300_000

/** Read past the cache: asked for ("Refresh view"), or this screen wrote within the cache's lifetime. */
export function readsFresh(asked: boolean, lastWriteAt: number | null, now: number = Date.now()): boolean {
  return asked || (lastWriteAt != null && now - lastWriteAt < LIST_CACHE_MS)
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The list's path: its date range (local days) and, when `fresh`, past the API's read cache. */
export function campaignsListPath(opts: { range?: { start: Date; end: Date }; fresh?: boolean }): string {
  const qs = opts.range ? `&startDate=${ymd(opts.range.start)}&endDate=${ymd(opts.range.end)}` : ''
  return `/api/advertising/campaigns?limit=500${qs}${opts.fresh ? '&fresh=1' : ''}`
}
