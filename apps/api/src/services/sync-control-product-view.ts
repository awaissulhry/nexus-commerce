/**
 * SCV.1 — product-first Sync Control aggregation.
 *
 * Pure presentation reducer: folds a product's per-listing SyncControl rows
 * (each already derived by resolveIntendedQuantity / resolveMembershipIntended)
 * into ONE product-level rollup — mode distribution, FBA presence, drift count,
 * routed-location union. No DB, no derivation of its own, so it is unit-tested
 * in isolation and can never disagree with the engine.
 */

/** Minimal shape the rollup needs from a computed SyncControl row. */
export interface SyncRowLike {
  channel: string
  /** 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED' */
  mode: string
  intendedQty: number | null
  liveQty: number | null
  buffer: number
  routedLocations: string[]
}

export interface ProductSyncRollup {
  /** Number of controllable rows (listings + shared memberships) for the product. */
  listings: number
  /** Distinct channels the product is on, sorted. */
  channels: string[]
  /** Count per mode, e.g. { FOLLOW: 4, PINNED: 1 }. */
  modeCounts: Record<string, number>
  /** The single mode when uniform; otherwise the most common NON-FBA mode
   *  (falls back to the most common mode overall if every row is FBA). */
  dominantMode: string | null
  /** True when every row shares one mode. */
  uniform: boolean
  /** True when any row is Amazon-managed (FBA) — surfaces the untouchable badge. */
  hasFba: boolean
  /** Largest per-listing buffer across the product. */
  maxBuffer: number
  /** Union of routed locations across FOLLOW rows, sorted. */
  routedLocations: string[]
  /** Rows whose live quantity differs from intended (both known) — live drift. */
  driftCount: number
}

/**
 * Fold a product's rows into its rollup. Drift compares live vs intended only
 * where BOTH are known (FOLLOW/PINNED rows carry an intended; FBA/UNCOUNTED/
 * PAUSED do not, so they never count as drift).
 */
export function summarizeProductSync(rows: SyncRowLike[]): ProductSyncRollup {
  const modeCounts: Record<string, number> = {}
  const channels = new Set<string>()
  const routed = new Set<string>()
  let hasFba = false
  let maxBuffer = 0
  let driftCount = 0

  for (const r of rows) {
    modeCounts[r.mode] = (modeCounts[r.mode] ?? 0) + 1
    channels.add(r.channel)
    for (const loc of r.routedLocations) routed.add(loc)
    if (r.mode === 'FBA') hasFba = true
    if (r.buffer > maxBuffer) maxBuffer = r.buffer
    if (r.intendedQty != null && r.liveQty != null && r.intendedQty !== r.liveQty) driftCount++
  }

  const modes = Object.keys(modeCounts)
  const uniform = modes.length === 1
  let dominantMode: string | null = null
  if (rows.length > 0) {
    const nonFba = modes.filter((m) => m !== 'FBA')
    const pool = nonFba.length > 0 ? nonFba : modes
    dominantMode = pool.reduce((best, m) => (modeCounts[m] > (modeCounts[best] ?? 0) ? m : best), pool[0])
  }

  return {
    listings: rows.length,
    channels: [...channels].sort(),
    modeCounts,
    dominantMode,
    uniform,
    hasFba,
    maxBuffer,
    routedLocations: [...routed].sort(),
    driftCount,
  }
}

/** Normalize an eBay market token (EBAY_IT → IT) for filter comparison. */
export function marketMatches(rowMarketplace: string, filter: string): boolean {
  return rowMarketplace.toUpperCase().replace(/^EBAY_/, '') === filter.toUpperCase()
}
