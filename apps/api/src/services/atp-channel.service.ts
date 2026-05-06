/**
 * R.2 — Channel-to-location resolution.
 *
 * Given a product's per-location stock breakdown (from
 * atp.service.ts) plus a (channel, marketplace) pair, returns the
 * specific stock available for selling on that channel-marketplace.
 *
 * Resolution rules (in order, first match wins):
 *   1. AMAZON + FBA fulfillment: AMAZON_FBA locations whose
 *      servesMarketplaces includes the marketplace (or 'GLOBAL'
 *      wildcard).
 *   2. AMAZON + FBM, OR any non-Amazon channel: WAREHOUSE locations
 *      whose servesMarketplaces includes the marketplace (or
 *      'GLOBAL' wildcard).
 *   3. Fallback: the default warehouse (StockLocation with
 *      code='IT-MAIN', else the first active WAREHOUSE).
 *   4. Otherwise: source='NO_LOCATION', available=0.
 *
 * When multiple locations match, sum their available — Amazon's
 * pan-EU FBA pool is an example: a single AMAZON-EU-FBA location
 * with servesMarketplaces=['IT','DE','FR','ES','NL','PL','SE'].
 *
 * GLOBAL wildcard: a location with servesMarketplaces=['GLOBAL']
 * matches any marketplace, but is preferred AFTER exact-marketplace
 * matches. So a warehouse explicitly serving IT wins over a generic
 * GLOBAL warehouse if both exist.
 */

export type ChannelLocationSource =
  | 'EXACT_MATCH'
  | 'WAREHOUSE_DEFAULT'
  | 'NO_LOCATION'

export interface ChannelStockResult {
  locationId: string | null
  locationCode: string | null
  available: number
  source: ChannelLocationSource
}

export interface AtpLocationRow {
  locationId: string
  locationCode: string
  locationName: string
  locationType: 'WAREHOUSE' | 'AMAZON_FBA' | 'CHANNEL_RESERVED'
  servesMarketplaces: string[]
  quantity: number
  reserved: number
  available: number
}

export interface ResolveStockForChannelArgs {
  byLocation: AtpLocationRow[]
  channel: string
  marketplace: string
  fulfillmentMethod?: 'FBA' | 'FBM' | null
}

/**
 * Pick rows whose servesMarketplaces matches the marketplace exactly
 * OR contains the GLOBAL wildcard. Exact matches sort first.
 */
function pickByMarketplace(
  rows: AtpLocationRow[],
  marketplace: string,
): { exact: AtpLocationRow[]; global: AtpLocationRow[] } {
  const exact: AtpLocationRow[] = []
  const global: AtpLocationRow[] = []
  for (const row of rows) {
    if (row.servesMarketplaces.includes(marketplace)) {
      exact.push(row)
    } else if (row.servesMarketplaces.includes('GLOBAL')) {
      global.push(row)
    }
  }
  return { exact, global }
}

function summarize(rows: AtpLocationRow[]): { available: number; locationId: string | null; locationCode: string | null } {
  if (rows.length === 0) return { available: 0, locationId: null, locationCode: null }
  if (rows.length === 1) {
    return { available: rows[0].available, locationId: rows[0].locationId, locationCode: rows[0].locationCode }
  }
  // Multiple rows (e.g. pan-EU FBA pool with several entries) → sum.
  const available = rows.reduce((s, r) => s + r.available, 0)
  return { available, locationId: null, locationCode: rows.map((r) => r.locationCode).join('+') }
}

export function resolveStockForChannel(args: ResolveStockForChannelArgs): ChannelStockResult {
  const isAmazonFba =
    args.channel === 'AMAZON' && args.fulfillmentMethod === 'FBA'

  // Step 1 — channel-specific candidates
  const candidatePool = args.byLocation.filter((r) =>
    isAmazonFba
      ? r.locationType === 'AMAZON_FBA'
      : r.locationType === 'WAREHOUSE',
  )
  const { exact, global } = pickByMarketplace(candidatePool, args.marketplace)

  if (exact.length > 0) {
    const s = summarize(exact)
    return { ...s, source: 'EXACT_MATCH' }
  }
  if (global.length > 0) {
    const s = summarize(global)
    return { ...s, source: 'EXACT_MATCH' }
  }

  // Step 2 — fallback to default warehouse (regardless of marketplace)
  const warehouseRows = args.byLocation.filter((r) => r.locationType === 'WAREHOUSE')
  // Prefer IT-MAIN (Xavia convention); else first warehouse.
  const itMain = warehouseRows.find((r) => r.locationCode === 'IT-MAIN')
  const fallback = itMain ?? warehouseRows[0]
  if (fallback) {
    return {
      locationId: fallback.locationId,
      locationCode: fallback.locationCode,
      available: fallback.available,
      source: 'WAREHOUSE_DEFAULT',
    }
  }

  // Step 3 — no locations at all
  return { locationId: null, locationCode: null, available: 0, source: 'NO_LOCATION' }
}
