/**
 * O.7 — Sendcloud webhook receiver.
 *
 * POST /api/webhooks/sendcloud
 *
 * Sendcloud sends a webhook each time a parcel transitions: ready,
 * picked up by carrier, in transit, out for delivery, delivered,
 * exception, returned to sender, cancelled. Each call:
 *   1. Verifies the request signature (HMAC-SHA256 over the raw body
 *      with NEXUS_SENDCLOUD_WEBHOOK_SECRET, compared to the
 *      Sendcloud-Signature header).
 *   2. Resolves the parcel → Shipment via sendcloudParcelId.
 *   3. Maps the carrier code → our normalized TrackingEvent.code.
 *   4. Inserts a TrackingEvent row (idempotent on duplicate deliveries
 *      via a fingerprint check).
 *   5. Advances Shipment.status when the event is terminal
 *      (LABEL_PRINTED → SHIPPED → IN_TRANSIT → DELIVERED).
 *   6. Enqueues a TrackingMessageLog (status=PENDING) so the retry
 *      job (O.12) pushes the tracking + status back to the order's
 *      channel (Amazon submitShippingConfirmation, eBay markAsShipped,
 *      Shopify fulfillmentCreate, Woo status update).
 *
 * In dryRun mode (NEXUS_ENABLE_SENDCLOUD_REAL=false) Sendcloud isn't
 * sending real webhooks — but the route still works for manual curl
 * tests + future replay tooling. Signature check is enforced regardless
 * so the surface stays safe to expose publicly.
 */

import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import prisma from '../db.js'
import { publishOutboundEvent } from '../services/outbound-events.service.js'

// ── Sendcloud parcel-status code → our normalized TrackingEvent code ──
// Subset; full list at https://api.sendcloud.dev. Anything not in the
// map falls through to 'INFO' so we still record the event without
// forcing a transition.
const PARCEL_STATUS_MAP: Record<number, {
  trackingCode: string
  shipmentStatus?: 'SHIPPED' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED' | 'RETURNED'
}> = {
  // "Ready to send" — label printed, carrier hasn't picked up yet.
  1: { trackingCode: 'ANNOUNCED' },
  // Picked up by carrier (depot scan).
  3: { trackingCode: 'PICKED_UP', shipmentStatus: 'SHIPPED' },
  // In transit through the network.
  4: { trackingCode: 'IN_TRANSIT', shipmentStatus: 'IN_TRANSIT' },
  // Out for delivery (last-mile vehicle).
  5: { trackingCode: 'OUT_FOR_DELIVERY', shipmentStatus: 'IN_TRANSIT' },
  // Delivered.
  11: { trackingCode: 'DELIVERED', shipmentStatus: 'DELIVERED' },
  // Awaiting customer pickup at a service point.
  13: { trackingCode: 'INFO' },
  // Delivery attempt failed.
  15: { trackingCode: 'DELIVERY_ATTEMPTED' },
  // Returned to sender.
  62: { trackingCode: 'RETURNED_TO_SENDER', shipmentStatus: 'RETURNED' },
  // Exception (damaged, lost, address issue).
  80: { trackingCode: 'EXCEPTION' },
  // Cancelled.
  999: { trackingCode: 'CANCELLED', shipmentStatus: 'CANCELLED' },
}

interface SendcloudWebhookBody {
  action?: string
  timestamp?: number
  parcel?: {
    id?: number
    tracking_number?: string | null
    tracking_url?: string | null
    status?: { id?: number; message?: string }
    carrier?: { code?: string }
    parcel_status_history?: Array<{
      parcel_status?: { id?: number; message?: string }
      timestamp?: string
      location?: string
    }>
  }
}

/**
 * Constant-time signature compare. Sendcloud sends the HMAC-SHA256 hex
 * digest in the Sendcloud-Signature header. We compute it over the raw
 * request body using the integration's webhook secret.
 */
function verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  // Constant-time compare — both buffers must be the same length, so
  // we pad/truncate via Buffer.from before timingSafeEqual.
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(signature, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function sendcloudWebhookRoutes(app: FastifyInstance) {
  // Sendcloud sends application/x-www-form-urlencoded by default; some
  // integrations are configured for JSON. We accept both — Fastify's
  // default JSON parser handles JSON; for URL-encoded we read raw and
  // parse manually (form bodies wrap the JSON payload as a single
  // `payload` field per Sendcloud's docs).
  app.post('/api/webhooks/sendcloud', async (request, reply) => {
    const secret = process.env.NEXUS_SENDCLOUD_WEBHOOK_SECRET
    if (!secret) {
      app.log.warn('[sendcloud-webhook] NEXUS_SENDCLOUD_WEBHOOK_SECRET not set — refusing')
      return reply.code(503).send({ error: 'Webhook secret not configured' })
    }

    const sig = (request.headers['sendcloud-signature'] ?? request.headers['x-sendcloud-signature']) as string | undefined
    // Reconstruct raw body for signature check. Fastify has already
    // parsed `request.body` by this point; we re-stringify for HMAC.
    // Sendcloud signs the body bytes Sendcloud sent — round-tripping
    // through JSON.stringify is acceptable here because Sendcloud
    // emits canonical JSON without whitespace, and we configure their
    // panel to send JSON (not form-encoded). If a future integration
    // sends form-encoded, swap the parser to capture rawBody verbatim.
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {})
    if (!verifySignature(rawBody, sig, secret)) {
      app.log.warn('[sendcloud-webhook] signature mismatch')
      return reply.code(401).send({ error: 'Invalid signature' })
    }

    const body = (typeof request.body === 'string'
      ? JSON.parse(request.body)
      : request.body) as SendcloudWebhookBody

    const parcel = body.parcel
    if (!parcel?.id) {
      return reply.code(400).send({ error: 'parcel.id required' })
    }

    // Resolve parcel → Shipment first (the common, outbound path).
    const shipment = await prisma.shipment.findUnique({
      where: { sendcloudParcelId: String(parcel.id) },
      include: { order: { select: { id: true, channel: true, marketplace: true } } },
    })
    if (!shipment) {
      // R0.3 (B3) — fall back to Return resolution. /generate-label
      // creates Sendcloud parcels with is_return=true and stores the
      // parcel id on Return.sendcloudParcelId. When the customer
      // hands the box to a carrier, the same status webhook fires
      // and we want to advance Return.status (REQUESTED → IN_TRANSIT)
      // instead of black-boxing.
      const ret = await prisma.return.findFirst({
        where: { sendcloudParcelId: String(parcel.id) },
        select: {
          id: true,
          status: true,
          rmaNumber: true,
          returnTrackingNumber: true,
        },
      })
      if (ret) {
        const mapped = PARCEL_STATUS_MAP[parcel.status?.id ?? 0] ?? { trackingCode: 'INFO' }
        // Only advance to IN_TRANSIT on the first carrier scan; never
        // auto-promote to RECEIVED — that requires physical-receipt
        // confirmation by the operator (we don't trust "delivered to
        // warehouse" scans to skip the inspection workflow).
        const isFirstScan =
          (mapped.trackingCode === 'PICKED_UP' || mapped.trackingCode === 'IN_TRANSIT') &&
          ret.status === 'REQUESTED'
        const updateData: any = {
          version: { increment: 1 },
        }
        if (isFirstScan) updateData.status = 'IN_TRANSIT'
        if (parcel.tracking_number && !ret.returnTrackingNumber) {
          updateData.returnTrackingNumber = parcel.tracking_number
        }
        if (Object.keys(updateData).length > 1) {
          await prisma.return.update({
            where: { id: ret.id },
            data: updateData,
          })
        }
        // Audit the carrier event regardless of whether we advanced
        // status — operators reading the audit trail want to see all
        // carrier scans, not just the ones that flipped state.
        try {
          await prisma.auditLog.create({
            data: {
              entityType: 'Return',
              entityId: ret.id,
              action: 'carrier-scan',
              metadata: {
                source: 'SENDCLOUD',
                code: mapped.trackingCode,
                statusId: parcel.status?.id ?? null,
                tracking: parcel.tracking_number ?? null,
                advancedTo: isFirstScan ? 'IN_TRANSIT' : null,
              } as any,
            },
          })
        } catch (e) {
          app.log.warn({ err: e }, '[sendcloud-webhook] return audit write failed')
        }
        return { ok: true, kind: 'return', returnId: ret.id, advanced: isFirstScan }
      }
      // Unknown parcel — log + 200 so Sendcloud doesn't retry forever.
      app.log.info({ parcelId: parcel.id }, '[sendcloud-webhook] unknown parcel')
      return reply.code(200).send({ ok: true, ignored: 'unknown_parcel' })
    }

    const statusId = parcel.status?.id ?? 0
    const mapped = PARCEL_STATUS_MAP[statusId] ?? { trackingCode: 'INFO' }
    const description = parcel.status?.message ?? mapped.trackingCode

    // Idempotency: dedupe on (shipmentId, code, occurredAt). Sendcloud
    // occasionally re-delivers the same status; we don't want duplicate
    // timeline rows. occurredAt comes from parcel_status_history when
    // available, otherwise body.timestamp, otherwise now().
    const occurredAt =
      parcel.parcel_status_history?.find((h) => h.parcel_status?.id === statusId)?.timestamp
        ? new Date(parcel.parcel_status_history.find((h) => h.parcel_status?.id === statusId)!.timestamp!)
        : body.timestamp
        ? new Date(body.timestamp * 1000)
        : new Date()
    const location =
      parcel.parcel_status_history?.find((h) => h.parcel_status?.id === statusId)?.location ?? null

    const existing = await prisma.trackingEvent.findFirst({
      where: {
        shipmentId: shipment.id,
        code: mapped.trackingCode,
        occurredAt,
      },
      select: { id: true },
    })
    if (existing) {
      return { ok: true, deduped: true }
    }

    // Insert TrackingEvent.
    await prisma.trackingEvent.create({
      data: {
        shipmentId: shipment.id,
        occurredAt,
        code: mapped.trackingCode,
        description,
        location,
        source: 'SENDCLOUD',
        carrierRawCode: String(statusId),
        carrierRawPayload: parcel as any,
      },
    })

    // O.32: push to SSE subscribers so open browsers refresh in real time.
    publishOutboundEvent({
      type: 'tracking.event',
      shipmentId: shipment.id,
      code: mapped.trackingCode,
      ts: Date.now(),
    })

    // Advance Shipment.status when terminal. Don't downgrade — if the
    // shipment is already DELIVERED, ignore an IN_TRANSIT event arriving
    // out of order (Sendcloud's history-replay can produce these).
    const ORDER: Record<string, number> = {
      DRAFT: 0, READY_TO_PICK: 1, PICKED: 2, PACKED: 3, LABEL_PRINTED: 4,
      SHIPPED: 5, IN_TRANSIT: 6, DELIVERED: 7, RETURNED: 8, CANCELLED: 9,
    }
    if (mapped.shipmentStatus) {
      const newStatus = mapped.shipmentStatus
      const currentRank = ORDER[shipment.status] ?? -1
      const newRank = ORDER[newStatus] ?? -1
      if (newRank > currentRank) {
        // O.32: push the status transition.
        publishOutboundEvent({
          type: 'shipment.updated',
          shipmentId: shipment.id,
          status: newStatus,
          ts: Date.now(),
        })
        const updateData: any = {
          status: newStatus,
          version: { increment: 1 },
        }
        if (newStatus === 'SHIPPED' && !shipment.shippedAt) updateData.shippedAt = occurredAt
        if (newStatus === 'DELIVERED' && !shipment.deliveredAt) updateData.deliveredAt = occurredAt
        if (newStatus === 'CANCELLED' && !shipment.cancelledAt) updateData.cancelledAt = occurredAt
        // Mirror tracking number/url onto the shipment if Sendcloud is
        // delivering them now (sometimes label creation predates them).
        if (parcel.tracking_number && !shipment.trackingNumber) {
          updateData.trackingNumber = parcel.tracking_number
        }
        if (parcel.tracking_url && !shipment.trackingUrl) {
          updateData.trackingUrl = parcel.tracking_url
        }
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: updateData,
        })

        // O.30: customer email on terminal transitions for direct
        // channels (Shopify, Woo). Marketplace channels (Amazon, eBay)
        // skip — those marketplaces send their own. Fire-and-forget
        // (non-blocking).
        if (shipment.order && (newStatus === 'SHIPPED' || newStatus === 'DELIVERED')) {
          const isDirect = ['SHOPIFY', 'WOOCOMMERCE'].includes(shipment.order.channel as string)
          if (isDirect) {
            void (async () => {
              try {
                const { sendShipmentEmail } = await import('../services/email/index.js')
                // Need full order for email — re-fetch with the
                // customer fields. Cheap; webhook is rare.
                const fullOrder = await prisma.order.findUnique({
                  where: { id: shipment.order!.id },
                  select: {
                    customerEmail: true,
                    customerName: true,
                    channelOrderId: true,
                    latestDeliveryDate: true,
                    shippingAddress: true,
                  },
                })
                if (!fullOrder?.customerEmail) return
                const ship = fullOrder.shippingAddress as any
                const destCity = ship?.City ?? ship?.city ?? null
                const baseUrl = process.env.NEXUS_BRANDED_TRACKING_BASE_URL ?? ''
                await sendShipmentEmail(newStatus === 'SHIPPED' ? 'shipped' : 'delivered', {
                  to: fullOrder.customerEmail,
                  customerName: fullOrder.customerName ?? '',
                  orderId: shipment.order!.id,
                  orderChannelId: fullOrder.channelOrderId,
                  trackingNumber: parcel.tracking_number ?? shipment.trackingNumber,
                  trackingUrl: parcel.tracking_url ?? shipment.trackingUrl,
                  carrier: parcel.carrier?.code ?? shipment.carrierCode,
                  estimatedDelivery: fullOrder.latestDeliveryDate
                    ? fullOrder.latestDeliveryDate.toISOString()
                    : null,
                  destinationCity: destCity,
                  brandedTrackingUrl:
                    baseUrl && shipment.trackingNumber
                      ? `${baseUrl}/track/${encodeURIComponent(shipment.trackingNumber)}`
                      : null,
                  locale: 'it',
                })
              } catch (err) {
                app.log.warn({ err }, '[sendcloud-webhook] customer email failed (non-fatal)')
              }
            })()
          }
        }

        // Enqueue channel pushback (only when an actual ship-out
        // happened — DELIVERED / IN_TRANSIT updates aren't separately
        // pushed to Amazon/eBay; their first SHIPPED event is what
        // they care about). Skip when no order is attached (orphaned
        // shipment) or when there's no active log entry to retry.
        if (newStatus === 'SHIPPED' && shipment.order) {
          const open = await prisma.trackingMessageLog.findFirst({
            where: {
              shipmentId: shipment.id,
              channel: shipment.order.channel,
              status: { in: ['PENDING', 'IN_FLIGHT'] },
            },
            select: { id: true },
          })
          if (!open) {
            await prisma.trackingMessageLog.create({
              data: {
                shipmentId: shipment.id,
                channel: shipment.order.channel,
                marketplace: shipment.order.marketplace,
                status: 'PENDING',
                nextAttemptAt: new Date(),
                requestPayload: {
                  trackingNumber: parcel.tracking_number ?? shipment.trackingNumber,
                  trackingUrl: parcel.tracking_url ?? shipment.trackingUrl,
                  carrierCode: parcel.carrier?.code ?? shipment.carrierCode,
                  shippedAt: occurredAt.toISOString(),
                  shipmentId: shipment.id,
                  orderId: shipment.order.id,
                },
              },
            })
          }
        }
      }
    }

    return { ok: true }
  })
}

export default sendcloudWebhookRoutes
