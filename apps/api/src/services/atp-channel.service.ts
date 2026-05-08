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

// S.26 — per-channel ATP rollup for the drawer.
//
// For a product, walk every ChannelListing row and compute:
//   ATP per channel = on-hand-at-relevant-locations
//                   - reservations attributed to that channel
//                   - ChannelListing.stockBuffer
//
// Exposed via /api/stock/product/:id bundle as `atpPerChannel`.

import prisma from '../db.js'

export interface ChannelAtpRow {
  channelListingId: string
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  externalListingId: string | null
  listingStatus: string
  stockBuffer: number
  followMasterQuantity: boolean
  resolvedLocationCode: string | null
  source: ChannelLocationSource
  // On-hand at the resolved location(s) before any subtraction.
  onHand: number
  reservedForChannel: number
  // Final number we'd push to the channel = max(0, onHand − reserved − buffer).
  available: number
  // Drift signal: what the listing currently reports vs. what we'd push.
  channelQuantity: number | null
  drift: number | null
}

/**
 * Per-product per-channel ATP. Pulls every ChannelListing row, resolves
 * the channel-relevant location(s), counts reservations attributed to
 * the channel via Order.channel match, applies stockBuffer.
 *
 * `byLocation` is supplied by the caller (already computed by the
 * /api/stock/product/:id handler) to avoid re-walking StockLevels.
 */
export async function resolveAtpAcrossChannels(args: {
  productId: string
  byLocation: AtpLocationRow[]
}): Promise<ChannelAtpRow[]> {
  const listings = await prisma.channelListing.findMany({
    where: { productId: args.productId },
    select: {
      id: true,
      channel: true,
      marketplace: true,
      externalListingId: true,
      listingStatus: true,
      stockBuffer: true,
      followMasterQuantity: true,
      quantity: true,
    },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
  })
  if (listings.length === 0) return []

  // Reservations attributed to each channel — via the StockReservation
  // → Order link. Active (not released, not consumed) reservations only.
  // Group by Order.channel so we can fold per-channel below.
  const activeReservations = await prisma.stockReservation.findMany({
    where: {
      releasedAt: null,
      consumedAt: null,
      stockLevel: { productId: args.productId },
      orderId: { not: null },
    },
    select: {
      quantity: true,
      orderId: true,
    },
  })
  let reservedByChannel = new Map<string, number>()
  if (activeReservations.length > 0) {
    const orderIds = activeReservations.map((r) => r.orderId!).filter(Boolean)
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, channel: true },
    })
    const channelByOrderId = new Map(orders.map((o) => [o.id, String(o.channel)]))
    for (const r of activeReservations) {
      const ch = channelByOrderId.get(r.orderId!) ?? 'UNKNOWN'
      reservedByChannel.set(ch, (reservedByChannel.get(ch) ?? 0) + r.quantity)
    }
  }

  return listings.map((l) => {
    // S.26 MVP — Amazon channel uses FBA-pool location (AMAZON_FBA);
    // every other channel uses warehouse fallback. A future commit
    // can tighten this when ChannelListing carries a per-listing
    // fulfillment-method override.
    const isAmazon = l.channel === 'AMAZON'
    const r = resolveStockForChannel({
      byLocation: args.byLocation,
      channel: l.channel,
      marketplace: l.marketplace,
      fulfillmentMethod: isAmazon ? 'FBA' : null,
    })
    const onHand = r.available
    const reservedForChannel = reservedByChannel.get(l.channel) ?? 0
    const buffer = l.stockBuffer ?? 0
    const available = Math.max(0, onHand - reservedForChannel - buffer)
    const drift = l.quantity == null ? null : available - l.quantity
    return {
      channelListingId: l.id,
      channel: l.channel,
      marketplace: l.marketplace,
      fulfillmentMethod: isAmazon ? 'FBA' : null,
      externalListingId: l.externalListingId,
      listingStatus: l.listingStatus,
      stockBuffer: buffer,
      followMasterQuantity: l.followMasterQuantity,
      resolvedLocationCode: r.locationCode,
      source: r.source,
      onHand,
      reservedForChannel,
      available,
      channelQuantity: l.quantity,
      drift,
    }
  })
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
