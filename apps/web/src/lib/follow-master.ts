import { getBackendUrl } from './backend-url'

/**
 * Shared client helper for the bulk Follow/Pinned action in both flat-file editors.
 *
 * Wraps the pool-safe endpoint POST /api/listings/follow-master-quantity, which:
 *  - sets each (product × channel × market) listing to FOLLOW the shared warehouse
 *    pool or PIN a fixed quantity, writing all three quantity columns coherently;
 *  - NEVER writes StockLevel / Product.totalStock (the warehouse pool);
 *  - skips Amazon FBA listings fail-closed (they're Amazon-managed);
 *  - no-op-skips anything already in the requested state.
 *
 * FBA rows should be excluded from `productIds` at the call site too (the endpoint
 * skips them regardless, but excluding keeps the confirm counts honest).
 */
export type FollowChannel = 'AMAZON' | 'EBAY'

export interface FollowApplyResult {
  updated: number
  skippedFba: number
  unchanged: number
  matched: number
  results?: Array<{
    listingId: string
    sku: string | null
    channel: string
    marketplace: string
    action: 'FOLLOW' | 'PIN' | 'SKIPPED_FBA' | 'UNCHANGED'
    quantity: number | null
  }>
}

export interface ApplyBulkFollowOpts {
  productIds: string[]
  channel: FollowChannel
  /** Active marketplace(s), e.g. ['IT']. */
  markets: string[]
  /** true → Follow the pool; false → Pinned (fixed quantity). */
  follow: boolean
}

/** Endpoint caps productIds at 500 per request. */
export const FOLLOW_APPLY_MAX = 500

/**
 * Apply Follow/Pinned to a set of products' listings. Chunks into ≤500-id batches
 * (the endpoint's server-side cap) and aggregates the counts, so a large
 * "Select all Pinned → Set Follow" over hundreds of rows works in one call.
 */
export async function applyBulkFollow(opts: ApplyBulkFollowOpts): Promise<FollowApplyResult> {
  const ids = [...new Set(opts.productIds.filter(Boolean))]
  const agg: FollowApplyResult = { updated: 0, skippedFba: 0, unchanged: 0, matched: 0, results: [] }
  if (ids.length === 0) return agg

  for (let i = 0; i < ids.length; i += FOLLOW_APPLY_MAX) {
    const chunk = ids.slice(i, i + FOLLOW_APPLY_MAX)
    const res = await fetch(`${getBackendUrl()}/api/listings/follow-master-quantity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: chunk, channel: opts.channel, markets: opts.markets, follow: opts.follow }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `Follow apply failed (HTTP ${res.status})`)
    }
    const r = (await res.json()) as FollowApplyResult
    agg.updated += r.updated ?? 0
    agg.skippedFba += r.skippedFba ?? 0
    agg.unchanged += r.unchanged ?? 0
    agg.matched += r.matched ?? 0
    if (Array.isArray(r.results)) agg.results!.push(...r.results)
  }
  return agg
}

export interface StockBufferResult {
  updated: number
  skippedFba: number
  unchanged: number
  matched: number
  results?: Array<{
    listingId: string; sku: string | null; channel: string; marketplace: string
    action: 'BUFFER' | 'SKIPPED_FBA' | 'UNCHANGED'; buffer: number; quantity: number | null
  }>
}

/**
 * Bulk-set the per-listing stock buffer (units reserved from the pool). A Following
 * listing then republishes pool−buffer; a Pinned listing just stores it. Same 500-id
 * chunking + aggregation as applyBulkFollow. Never touches the warehouse pool; the
 * endpoint skips FBA fail-closed.
 */
export async function applyBulkBuffer(opts: {
  productIds: string[]; channel: FollowChannel; markets: string[]; buffer: number
}): Promise<StockBufferResult> {
  const ids = [...new Set(opts.productIds.filter(Boolean))]
  const buffer = Math.max(0, Math.floor(opts.buffer || 0))
  const agg: StockBufferResult = { updated: 0, skippedFba: 0, unchanged: 0, matched: 0, results: [] }
  if (ids.length === 0) return agg
  for (let i = 0; i < ids.length; i += FOLLOW_APPLY_MAX) {
    const chunk = ids.slice(i, i + FOLLOW_APPLY_MAX)
    const res = await fetch(`${getBackendUrl()}/api/listings/stock-buffer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: chunk, channel: opts.channel, markets: opts.markets, buffer }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `Buffer apply failed (HTTP ${res.status})`)
    }
    const r = (await res.json()) as StockBufferResult
    agg.updated += r.updated ?? 0
    agg.skippedFba += r.skippedFba ?? 0
    agg.unchanged += r.unchanged ?? 0
    agg.matched += r.matched ?? 0
    if (Array.isArray(r.results)) agg.results!.push(...r.results)
  }
  return agg
}
