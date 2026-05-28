/**
 * FCF.5b — auto-submit Amazon MCF for a newly-ingested eBay order whose
 * listings are MCF-backed (ChannelListing.fulfillmentMethod='FBA' on the eBay
 * channel — see docs/FULFILLMENT-PER-CHANNEL.md).
 *
 * Called fire-and-forget from the eBay order ingestion AFTER OrderItems are
 * written. Double-gated by the caller (NEXUS_EBAY_AUTO_MCF=1) and here
 * (AMAZON_MCF_LIVE=1 — no point reserving FBA stock against the stub adapter,
 * which would just churn reserve→release). Conservative eligibility: EVERY
 * order item must map to a product with an MCF-backed eBay listing, otherwise
 * we skip and leave the order for the operator to fulfil manually via the
 * /fulfillment/stock/mcf dashboard. createMCFShipment is idempotent (one active
 * shipment per order), so a re-run is safe.
 */

import prisma from '../db.js'
import { logger } from './../utils/logger.js'
import { createMCFShipment, resolveMcfAdapter } from './amazon-mcf.service.js'

export type AutoMcfResult =
  | { submitted: true; mcfShipmentId: string; amazonFulfillmentOrderId: string }
  | { submitted: false; reason: string }

export async function autoSubmitMcfForEbayOrder(orderId: string): Promise<AutoMcfResult> {
  // Gate: only with a live adapter — the stub would reserve then release.
  if (process.env.AMAZON_MCF_LIVE !== '1') {
    return { submitted: false, reason: 'adapter-not-live' }
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      channel: true,
      fulfillmentMethod: true,
      items: { select: { productId: true, quantity: true } },
    },
  })
  if (!order) return { submitted: false, reason: 'order-not-found' }
  if (order.channel !== 'EBAY') return { submitted: false, reason: 'not-ebay' }
  if (order.fulfillmentMethod === 'MCF') return { submitted: false, reason: 'already-mcf' }

  const items = order.items.filter((it) => it.quantity > 0)
  if (items.length === 0) return { submitted: false, reason: 'no-items' }

  // Every item must map to a product that has an MCF-backed (FBA) eBay listing.
  const productIds = [...new Set(items.map((it) => it.productId).filter((p): p is string => !!p))]
  if (productIds.length === 0 || productIds.length !== new Set(items.map((it) => it.productId)).size) {
    // An unlinked item (productId null) means we can't prove MCF eligibility.
    return { submitted: false, reason: 'unlinked-item' }
  }

  const mcfListings = await prisma.channelListing.findMany({
    where: { productId: { in: productIds }, channel: 'EBAY', fulfillmentMethod: 'FBA' },
    select: { productId: true },
  })
  const mcfProductIds = new Set(mcfListings.map((l) => l.productId))
  const allMcf = productIds.every((pid) => mcfProductIds.has(pid))
  if (!allMcf) return { submitted: false, reason: 'not-all-items-mcf' }

  // Submit. createMCFShipment reserves AMAZON-EU-FBA, calls the SP-API adapter,
  // persists the MCFShipment, and sets Order.fulfillmentMethod='MCF'.
  const shipment = await createMCFShipment(resolveMcfAdapter(), {
    orderId,
    comment: 'Auto-submitted from eBay order (FCF.5b)',
  })
  logger.info('ebay-auto-mcf: submitted', {
    orderId,
    mcfShipmentId: shipment.id,
    amazonFulfillmentOrderId: shipment.amazonFulfillmentOrderId,
  })
  return {
    submitted: true,
    mcfShipmentId: shipment.id,
    amazonFulfillmentOrderId: shipment.amazonFulfillmentOrderId,
  }
}
