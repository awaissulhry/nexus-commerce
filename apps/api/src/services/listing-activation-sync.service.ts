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
import { QUANTITY_PUSH_CHANNELS, resolveIntendedQuantity } from './sync-control-core.js'
import { loadChannelPolicies, policyFor } from './sync-control-policy.service.js'
import { ledgerInputs, loadSyncLedgers } from './stock-pool/sync-ledgers.js'

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
        marketplace: true,
        stockBuffer: true,
        externalListingId: true,
        followMasterQuantity: true,
        fulfillmentMethod: true,
        syncPaused: true,
        offerClosedAt: true,
        sourceLocationCodes: true,
        channelConnectionId: true,
        product: { select: { fulfillmentMethod: true } },
      },
    })

    // Batch: one ledger read for every distinct productId.
    const productIds = [...new Set(listings.map((l) => l.productId).filter(Boolean))] as string[]
    // RT.2 — WAREHOUSE-only + SUMMED (the old read picked up the AMAZON_FBA mirror row and kept
    // only the LAST row per product). Shared stock: loadSyncLedgers gives a pooled product the
    // pool's lent locations instead of this business's own rows.
    const ledgers = await loadSyncLedgers(prisma, productIds)
    const scPolicies = await loadChannelPolicies()

    const rows: any[] = []
    let uncountedSkips = 0
    for (const listing of listings) {
      if (!listing.productId || !QUANTITY_PUSH_CHANNELS.has(listing.channel)) continue
      // SC.1b — full core derivation (routing + pause + policy + pin + FBA);
      // non-FOLLOW resolutions (incl. the AS.5 UNCOUNTED guard) enqueue nothing.
      const scRes = resolveIntendedQuantity({
        channel: listing.channel,
        marketplace: (listing as { marketplace?: string }).marketplace ?? 'DEFAULT',
        offerClosed: !!(listing as { offerClosedAt?: Date | null }).offerClosedAt,
        isFba:
          (listing as { fulfillmentMethod?: string | null }).fulfillmentMethod === 'FBA' ||
          ((listing as { fulfillmentMethod?: string | null }).fulfillmentMethod == null &&
            (listing as { product?: { fulfillmentMethod?: string | null } }).product?.fulfillmentMethod === 'FBA'),
        followMasterQuantity: (listing as { followMasterQuantity?: boolean }).followMasterQuantity ?? true,
        syncPaused: (listing as { syncPaused?: boolean }).syncPaused ?? false,
        pinnedQuantity: null,
        stockBuffer: listing.stockBuffer ?? 0,
        channelPolicy: policyFor(scPolicies, listing.channel, (listing as { marketplace?: string }).marketplace ?? 'DEFAULT', listing.channelConnectionId),
        ...ledgerInputs(ledgers.get(listing.productId), (listing as { sourceLocationCodes?: string[] }).sourceLocationCodes ?? []),
      })
      if (scRes.kind !== 'FOLLOW') {
        if (scRes.kind === 'UNCOUNTED') uncountedSkips++
        continue
      }
      const bufferedQty = scRes.quantity
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
      // RT.2 — instant lane (5s activation grace honored as job delay).
      const { enqueueOutboundRowsInstant } = await import('./outbound-enqueue.js')
      await enqueueOutboundRowsInstant(prisma, rows, { source: 'LISTING_ACTIVATED' })
      logger.info('[listing-activation-sync] enqueued QUANTITY_UPDATE (instant lane)', {
        count: rows.length,
        uncountedSkips,
        listingIds: listingIds.slice(0, 10),
      })
    }
  } catch (err) {
    logger.warn('[listing-activation-sync] failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
