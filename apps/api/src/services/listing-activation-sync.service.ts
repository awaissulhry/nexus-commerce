/**
 * IS.2b — Sync inventory to channel when a listing is activated.
 *
 * When offerActive or isPublished flips to true, the listing's channel
 * qty may be stale (it was skipped by all cascades while inactive).
 * This service reads the current StockLevel.available for each product
 * and enqueues a QUANTITY_UPDATE so the channel reflects the real stock
 * immediately after activation — no order needed to trigger it.
 *
 * Call fire-and-forget from any activation point.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const VALID_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY'])

/**
 * Enqueue QUANTITY_UPDATE for one or more just-activated listings.
 * Batches stock lookups by productId to avoid N+1 queries.
 */
export async function syncActivatedListings(listingIds: string[]): Promise<void> {
  if (listingIds.length === 0) return

  try {
    const listings = await prisma.channelListing.findMany({
      where: { id: { in: listingIds } },
      select: {
        id: true,
        productId: true,
        channel: true,
        region: true,
        stockBuffer: true,
        externalListingId: true,
      },
    })

    // Batch: one StockLevel query per distinct productId
    const productIds = [...new Set(listings.map((l) => l.productId).filter(Boolean))] as string[]
    const stockLevels = await prisma.stockLevel.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, available: true },
    })
    const availableByProduct = new Map(stockLevels.map((sl) => [sl.productId, sl.available]))

    const rows: any[] = []
    for (const listing of listings) {
      if (!listing.productId || !VALID_CHANNELS.has(listing.channel)) continue
      const available = availableByProduct.get(listing.productId) ?? 0
      const bufferedQty = Math.max(0, available - (listing.stockBuffer ?? 0))
      rows.push({
        productId: listing.productId,
        channelListingId: listing.id,
        targetChannel: listing.channel,
        targetRegion: listing.region ?? undefined,
        syncType: 'QUANTITY_UPDATE',
        syncStatus: 'PENDING',
        payload: { quantity: bufferedQty, source: 'LISTING_ACTIVATED' },
        externalListingId: listing.externalListingId ?? undefined,
        retryCount: 0,
        maxRetries: 3,
        holdUntil: new Date(Date.now() + 5_000),
      })
    }

    if (rows.length > 0) {
      await prisma.outboundSyncQueue.createMany({ data: rows })
      logger.info('[listing-activation-sync] enqueued QUANTITY_UPDATE', {
        count: rows.length,
        listingIds: listingIds.slice(0, 10),
      })
    }
  } catch (err) {
    logger.warn('[listing-activation-sync] failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
