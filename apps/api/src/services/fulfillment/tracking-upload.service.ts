/**
 * MCP full control 07 O9 — the one writer of TrackingMessageLog: the row the tracking-pushback job
 * (jobs/tracking-pushback.job.ts, every 2 minutes) turns into the channel's ship confirmation with the tracking number.
 *
 * Two kinds of caller:
 *   - the Sendcloud webhook, on a parcel's first SHIPPED scan: exactly as before O9 (moved from
 *     routes/sendcloud-webhooks.routes.ts) — one open (PENDING / IN_FLIGHT) row per shipment and channel;
 *   - an explicit "it shipped" (`explicit: true`): marking a MANUAL-carrier shipment shipped (one, bulk, the Orders
 *     page's legacy bulk) and Claude's confirm-shipment. No webhook ever comes for a MANUAL carrier, so before O9 its
 *     tracking never reached the channel. An explicit upload is refused without a tracking number, for an order Amazon
 *     ships (FBA, MCF; fail closed), for a channel the job cannot serve yet, and when the shipment already has one.
 */

import prisma from '../../db.js'
import { amazonFulfilledRefusal } from './amazon-fulfilled-order.js'

/** The channels the pushback job sends a ship confirmation to (Etsy since O17). */
export const TRACKING_UPLOAD_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const

/** Whether a channel's ship confirmation is live or a dry run, from the switch the pushback itself reads. */
export function trackingUploadMode(channel: string): string {
  if (channel === 'AMAZON') return process.env.NEXUS_ENABLE_AMAZON_SHIP_CONFIRM === 'true' ? 'live' : 'dry run (NEXUS_ENABLE_AMAZON_SHIP_CONFIRM off)'
  if (channel === 'EBAY') return process.env.NEXUS_ENABLE_EBAY_SHIP_CONFIRM === 'true' ? 'live' : 'dry run (NEXUS_ENABLE_EBAY_SHIP_CONFIRM off)'
  if (channel === 'SHOPIFY') return process.env.NEXUS_ENABLE_SHOPIFY_SHIP_CONFIRM === 'true' ? 'live' : 'off: nothing is sent (NEXUS_ENABLE_SHOPIFY_SHIP_CONFIRM)'
  if (channel === 'ETSY') return process.env.NEXUS_ENABLE_ETSY_SHIP_CONFIRM === 'true' ? 'live' : 'off: nothing is sent (NEXUS_ENABLE_ETSY_SHIP_CONFIRM)'
  return `no tracking upload for ${channel} yet`
}

export interface TrackingUploadInput {
  shippedAt: Date
  trackingNumber?: string | null
  trackingUrl?: string | null
  carrierCode?: string | null
}

export type TrackingUploadOutcome = { queued: true; logId: string } | { queued: false; reason: string }

/** Queue the channel's tracking upload for one shipment, or say why not. */
export async function enqueueTrackingUpload(shipmentId: string, input: TrackingUploadInput, options: { explicit?: boolean } = {}): Promise<TrackingUploadOutcome> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, order: { select: { id: true, channel: true, marketplace: true, fulfillmentMethod: true } } },
  })
  const order = shipment?.order
  if (!shipment || !order) return { queued: false, reason: 'the shipment has no order' }
  if (options.explicit) {
    if (!input.trackingNumber) return { queued: false, reason: 'it has no tracking number' }
    if (!(TRACKING_UPLOAD_CHANNELS as readonly string[]).includes(order.channel)) return { queued: false, reason: `no tracking upload for ${order.channel} yet` }
    if (await amazonFulfilledRefusal(prisma, order)) return { queued: false, reason: 'Amazon ships this order (FBA or Multi-Channel Fulfilment)' }
    const any = await prisma.trackingMessageLog.findFirst({ where: { shipmentId, channel: order.channel }, select: { id: true } })
    if (any) return { queued: false, reason: 'its tracking upload is already queued or sent' }
  } else {
    const open = await prisma.trackingMessageLog.findFirst({
      where: { shipmentId, channel: order.channel, status: { in: ['PENDING', 'IN_FLIGHT'] } },
      select: { id: true },
    })
    if (open) return { queued: false, reason: 'its tracking upload is already queued' }
  }
  const row = await prisma.trackingMessageLog.create({
    data: {
      shipmentId,
      channel: order.channel,
      marketplace: order.marketplace,
      status: 'PENDING',
      nextAttemptAt: new Date(),
      requestPayload: {
        // As given (an absent value stays absent, as the webhook wrote it before O9).
        trackingNumber: input.trackingNumber,
        trackingUrl: input.trackingUrl,
        carrierCode: input.carrierCode,
        shippedAt: input.shippedAt.toISOString(),
        shipmentId,
        orderId: order.id,
      },
    },
    select: { id: true },
  })
  return { queued: true, logId: row.id }
}
