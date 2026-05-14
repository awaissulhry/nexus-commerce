/**
 * IS.2b — Content auto-publish.
 *
 * When a ChannelListing has _autoPublishContent=true in platformAttributes,
 * any save of content fields (title, description, images, bullets) enqueues
 * a FULL_SYNC row so the autopilot worker pushes the change to the channel
 * within ~60s — no manual publish needed.
 *
 * Called from:
 *   - POST /api/amazon/flat-file/sync-rows  (after syncRowsToPlatform)
 *   - POST /api/ebay/flat-file/rows         (after saving eBay rows)
 *   - PATCH /api/products/:id               (when name/description changes)
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

/**
 * For each listing in `listingIds` that has _autoPublishContent=true,
 * enqueue a FULL_SYNC carrying the current title/description/images.
 * Safe to call with an empty array.
 */
export async function enqueueContentSyncIfEnabled(listingIds: string[]): Promise<void> {
  if (!listingIds.length) return

  try {
    const listings = await prisma.channelListing.findMany({
      where: { id: { in: listingIds } },
      select: {
        id: true,
        productId: true,
        channel: true,
        marketplace: true,
        region: true,
        externalListingId: true,
        title: true,
        description: true,
        isPublished: true,
        offerActive: true,
        platformAttributes: true,
        product: {
          select: {
            id: true,
            name: true,
            description: true,
            images: { select: { url: true }, orderBy: { createdAt: 'asc' }, take: 10 },
          },
        },
      },
    })

    const rows = []
    for (const l of listings) {
      const attrs = (l.platformAttributes as Record<string, unknown> | null) ?? {}
      if (!attrs._autoPublishContent) continue
      if (!l.productId || !l.isPublished) continue
      if (!(['AMAZON', 'EBAY', 'SHOPIFY'] as string[]).includes(l.channel)) continue

      const title = l.title ?? l.product?.name ?? null
      const description = l.description ?? l.product?.description ?? null
      const images = (l.product?.images ?? []).map((i) => i.url).filter(Boolean)

      rows.push({
        productId: l.productId,
        channelListingId: l.id,
        targetChannel: l.channel as any,
        targetRegion: l.region ?? l.marketplace ?? undefined,
        syncType: 'FULL_SYNC' as const,
        syncStatus: 'PENDING' as const,
        payload: {
          title,
          description,
          images,
          source: 'CONTENT_AUTO_PUBLISH',
        },
        externalListingId: l.externalListingId ?? undefined,
        retryCount: 0,
        maxRetries: 3,
        holdUntil: new Date(Date.now() + 10 * 60 * 1000), // 10-min grace: batch rapid edits
      })
    }

    if (rows.length > 0) {
      await prisma.outboundSyncQueue.createMany({ data: rows as any, skipDuplicates: true })
      logger.info('[content-auto-publish] enqueued FULL_SYNC', { count: rows.length })
    }
  } catch (err) {
    logger.warn('[content-auto-publish] enqueue failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * For all active listings of `productId` that have _autoPublishContent=true
 * and followMasterTitle=true (or not set), enqueue FULL_SYNC.
 * Used when the master product name/description changes.
 */
export async function enqueueContentSyncForProduct(productId: string): Promise<void> {
  try {
    const listings = await prisma.channelListing.findMany({
      where: {
        productId,
        isPublished: true,
        offerActive: true,
      },
      select: { id: true, followMasterTitle: true, platformAttributes: true },
    })

    const eligible = listings
      .filter((l) => {
        const attrs = (l.platformAttributes as Record<string, unknown> | null) ?? {}
        if (!attrs._autoPublishContent) return false
        // Only push if the listing follows master title (not overridden)
        return l.followMasterTitle !== false
      })
      .map((l) => l.id)

    await enqueueContentSyncIfEnabled(eligible)
  } catch (err) {
    logger.warn('[content-auto-publish] product-level enqueue failed', {
      productId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
