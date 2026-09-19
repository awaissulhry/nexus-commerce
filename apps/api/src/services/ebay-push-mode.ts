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
 * The correctness rule this function enforces: ANY shared row, ANY synthesized `_shared` row, or ANY
 * duplicate SKU forces api mode regardless of count; an explicit `mode: 'api'` request is always
 * honored.
 *
 * P1.6 (Owner, 2026-09-20 — R-6): the ROW COUNT no longer chooses feed. Our Feed API lane creates the
 * task with a DOWNLOAD report type and then uploads to it, so it is very likely broken, and nothing in
 * the app ever asks for feed mode: a push of more than 50 rows was silently routed into it. Big pushes
 * now take the API lane. Only an explicit `mode: 'feed'` still asks for the feed lane (and a shared or
 * duplicate payload still overrides even that). P1.8 proves the lane against eBay's sandbox; when it is
 * green, the count heuristic can come back.
 */

export type EbayPushMode = 'api' | 'feed'

export interface PushModeDecision {
  mode: EbayPushMode
  /** True when feed was asked for — or the row count would once have chosen it — but a shared / duplicate row won. */
  forcedApi: boolean
  hasSharedRow: boolean
  hasDuplicateSku: boolean
}

/** Rows only need the fields the decision reads — keep the type minimal. */
type ModeRow = { sku?: unknown; shared_sku_listing?: unknown; _shared?: unknown }

/**
 * @param requested the caller's requested mode ('api' | 'feed' | undefined)
 * @param feedThreshold since P1.6 this only marks `forcedApi` for the log; it no longer chooses feed
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
  // P1.6 — only an explicit request asks for the feed lane. The row count stays as a DIAGNOSTIC: it
  // still marks a payload the old heuristic would have sent to the feed, which is what `forcedApi`
  // reports to the operator log.
  const countWantedFeed = rows.length > feedThreshold
  const heuristicFeed = requested === 'feed'
  const mode: EbayPushMode = mustUseApi ? 'api' : heuristicFeed ? 'feed' : 'api'

  return {
    mode,
    // "forced" only when the heuristic genuinely wanted feed but shared/dup won
    // (an explicit mode:'api' request is honored, not a forced override).
    forcedApi: (hasSharedRow || hasDuplicateSku) && (heuristicFeed || countWantedFeed) && requested !== 'api',
    hasSharedRow,
    hasDuplicateSku,
  }
}
