/**
 * MC.12.6 — Cascade image republish via OutboundSyncQueue.
 *
 * When a master image changes (operator replaces, or AI processes
 * it), every channel that lists the product needs the new image
 * pushed. Rather than firing the channel-publish endpoints
 * synchronously (which could be 4× slow + brittle), we enqueue
 * OutboundSyncQueue rows + let the existing outbound worker
 * pick them up.
 *
 * The worker (apps/api/src/workers/outbound-sync.worker.ts —
 * implementation pending the credential cutover) reads
 * targetChannel + payload + dispatches to the matching
 * channel-publish.service function. Sandbox mode means today's
 * worker would log status='SUCCESS' with fake channel ids;
 * production mode invokes the real APIs.
 */

import prisma from '../db.js'

interface EnqueueInput {
  productId: string
  assetUrl: string
  /// Optional asset id for audit correlation (logged on each
  /// queue row's payload).
  assetId?: string
  /// Optional override — by default we fan out to every channel
  /// the product has a ChannelListing in. Pass an explicit set
  /// here to limit (e.g. operator only wants Amazon + eBay).
  channels?: Array<'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'>
}

export interface EnqueueResult {
  productId: string
  enqueued: number
  channels: Array<{
    channel: string
    queueId: string
    destinationId: string
  }>
  skipped: Array<{ channel: string; reason: string }>
}

export async function enqueueCascadeRepublish(
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      sku: true,
      amazonAsin: true,
      ebayItemId: true,
      shopifyProductId: true,
      woocommerceProductId: true,
    },
  })
  if (!product)
    throw new Error(`Product ${input.productId} not found`)

  // Channel → destination id map. Skip channels where the product
  // doesn't have a listing yet.
  const channelDestinations: Array<{
    channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'
    destination: string | null
  }> = [
    { channel: 'AMAZON', destination: product.amazonAsin },
    { channel: 'EBAY', destination: product.ebayItemId },
    { channel: 'SHOPIFY', destination: product.shopifyProductId },
    {
      channel: 'WOOCOMMERCE',
      destination: product.woocommerceProductId
        ? String(product.woocommerceProductId)
        : null,
    },
  ]

  const limit = input.channels ? new Set(input.channels) : null

  const channels: EnqueueResult['channels'] = []
  const skipped: EnqueueResult['skipped'] = []

  for (const { channel, destination } of channelDestinations) {
    if (limit && !limit.has(channel)) continue
    if (!destination) {
      skipped.push({
        channel,
        reason: `Product has no ${channel} listing id`,
      })
      continue
    }
    const row = await prisma.outboundSyncQueue.create({
      data: {
        product: { connect: { id: product.id } },
        targetChannel: channel,
        syncStatus: 'PENDING',
        // Naming aligns with the existing OutboundSyncQueue.syncType
        // values (PRICE_UPDATE, QUANTITY_UPDATE, LISTING_SYNC,
        // OFFER_SYNC, FULL_SYNC). Image-republish gets its own
        // string so the worker can dispatch into the
        // channel-publish.service path.
        syncType: 'IMAGE_REPUBLISH',
        payload: {
          kind: 'image_republish',
          assetUrl: input.assetUrl,
          assetId: input.assetId ?? null,
          destinationId: destination,
          enqueuedAt: new Date().toISOString(),
        } as never,
      },
      select: { id: true },
    })
    channels.push({
      channel,
      queueId: row.id,
      destinationId: destination,
    })
  }

  return {
    productId: input.productId,
    enqueued: channels.length,
    channels,
    skipped,
  }
}
