/**
 * eBay push mode routing — decide feed (bulk Inventory API) vs api
 * (family-aware Trading/Inventory per row) for a set of flat-file rows.
 *
 * GALE incident #3 (2026-07-17): a row-count threshold force-routed an 84-row
 * SHARED multi-listing push into feed mode. Feed mode uses eBay's Inventory
 * feed, which requires UNIQUE SKUs and creates ONE listing per SKU — it cannot
 * represent the shared-SKU model (the SAME child SKUs across N listings). It
 * emitted duplicate NDJSON lines and its Feed API call failed → a bare HTTP
 * 500. Proven by replay: 124 rows → feed → 500; the same one family at 21 rows
 * → api → 200 clean.
 *
 * The correctness rule this function enforces: feed mode is ONLY ever chosen
 * for a genuine large UNIQUE-SKU, non-shared push. ANY shared row, ANY
 * synthesized `_shared` row, or ANY duplicate SKU forces api mode regardless
 * of count; an explicit `mode: 'api'` request is always honored.
 */

export type EbayPushMode = 'api' | 'feed'

export interface PushModeDecision {
  mode: EbayPushMode
  /** True when the count heuristic wanted feed but a shared/dup row overrode it. */
  forcedApi: boolean
  hasSharedRow: boolean
  hasDuplicateSku: boolean
}

/** Rows only need the fields the decision reads — keep the type minimal. */
type ModeRow = { sku?: unknown; shared_sku_listing?: unknown; _shared?: unknown }

/**
 * @param requested the caller's requested mode ('api' | 'feed' | undefined)
 * @param feedThreshold row count above which a UNIQUE-SKU push prefers feed
 */
export function decideEbayPushMode(
  rows: ModeRow[],
  requested: string | undefined,
  feedThreshold = 50,
): PushModeDecision {
  const skuSeen = new Set<string>()
  let hasDuplicateSku = false
  let hasSharedRow = false
  for (const r of rows) {
    const s = String(r.sku ?? '').trim()
    if (s) {
      if (skuSeen.has(s)) hasDuplicateSku = true
      else skuSeen.add(s)
    }
    if (r.shared_sku_listing === true || r._shared === true) hasSharedRow = true
  }

  const mustUseApi = requested === 'api' || hasSharedRow || hasDuplicateSku
  const heuristicFeed = requested === 'feed' || rows.length > feedThreshold
  const mode: EbayPushMode = mustUseApi ? 'api' : heuristicFeed ? 'feed' : 'api'

  return {
    mode,
    // "forced" only when the heuristic genuinely wanted feed but shared/dup won
    // (an explicit mode:'api' request is honored, not a forced override).
    forcedApi: (hasSharedRow || hasDuplicateSku) && heuristicFeed && requested !== 'api',
    hasSharedRow,
    hasDuplicateSku,
  }
}
