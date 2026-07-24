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

/**
 * SCV.1b — big-family threshold. A master with more than this many listed
 * variants (jackets/suits: 30–49) does NOT ship its child rows in the list
 * payload — the client shows an "Open ↗" button to the dedicated per-product
 * page instead. Keeps the 37-row overview light. Tunable via env.
 */
export const BIG_FAMILY_VARIANT_THRESHOLD = Number.parseInt(
  process.env.NEXUS_SCV_INLINE_VARIANT_MAX ?? '',
  10,
) || 20

/** True when a master's children should be omitted from the list payload. */
export function omitChildrenInList(variantCount: number, threshold = BIG_FAMILY_VARIANT_THRESHOLD): boolean {
  return variantCount > threshold
}

/**
 * SCD.1 — pure canonical-master resolution (the pool-derived grouping).
 *
 * The owner's insight, verified in the data: only PARENT skus differ between
 * duplicate copies; every copy shares the same CHILD skus via the shared
 * listing pool. So:
 *   - a master that OWNS child products is canonical → maps to itself;
 *   - a CHILDLESS master (a pure duplicate listing) folds into the canonical
 *     master whose variant products its listings pool (`canonicalMasterByItemId`).
 * A genuinely-different product shares no pool → resolves to self (never
 * wrongly merged). Deterministic, no regex/name/ASIN guessing.
 */
export function resolveCanonicalMap(
  masterIds: string[],
  mastersWithChildren: Set<string>,
  itemIdsByMaster: Map<string, string[]>,
  canonicalMasterByItemId: Map<string, string>,
  // SCD.1b — secondary fallback for a CHILDLESS, unpooled duplicate (a copy
  // whose listing isn't inventory-pooled, e.g. VENTRA-JACKET-ALT1): fold by
  // SKU stem into a same-stem canonical. Safe because a genuinely-different
  // product owns its own children (never childless), so it can never be
  // stem-merged.
  canonicalByStem?: Map<string, string>,
  stemOfMaster?: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const mid of masterIds) {
    if (mastersWithChildren.has(mid)) { out.set(mid, mid); continue }
    let resolved = mid
    for (const itemId of itemIdsByMaster.get(mid) ?? []) {
      const canonical = canonicalMasterByItemId.get(itemId)
      if (canonical && canonical !== mid) { resolved = canonical; break }
    }
    if (resolved === mid && canonicalByStem && stemOfMaster) {
      const canonical = canonicalByStem.get(stemOfMaster.get(mid) ?? '\0')
      if (canonical && canonical !== mid) resolved = canonical
    }
    out.set(mid, resolved)
  }
  return out
}

/** SCD.1b — canonical SKU stem: strip trailing -ALT#/-FBM/-FBA and a leading
 *  market prefix (IT-/DE-/FR-/ES-). Only the CHILDLESS-master fallback uses it. */
export function canonicalStem(sku: string): string {
  let s = sku.trim()
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')
  return s.toUpperCase()
}
