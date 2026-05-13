/**
 * IS.2 — eBay Notification Platform push webhook.
 *
 * Receives real-time push events from eBay's Notification Platform for:
 *   - marketplace.order.created  → immediately reserve stock + cascade
 *   - marketplace.order.cancelled → release reservations + cascade
 *
 * Setup in eBay Developer Console:
 *   1. Go to Application Keys → Notifications tab
 *   2. Set endpoint URL to: https://<your-api-domain>/api/webhooks/ebay-notification
 *   3. Set verification token in EBAY_NOTIFICATION_VERIFICATION_TOKEN env var
 *   4. Subscribe to topics: marketplace.order.created, marketplace.order.cancelled
 *
 * Signature verification uses HMAC-SHA256 with the verification token.
 *
 * Challenge endpoint: eBay sends a GET with ?challenge_code=xxx to verify
 * ownership. We respond with the HMAC-SHA256 of challenge_code.
 */

import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

function verifyEbaySignature(
  body: string,
  signatureHeader: string | undefined,
  token: string,
): boolean {
  if (!signatureHeader) return false
  try {
    const expected = crypto
      .createHmac('sha256', token)
      .update(body)
      .digest('base64')
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}

export default async function ebayNotificationRoutes(app: FastifyInstance): Promise<void> {
  // eBay challenge endpoint — required to verify webhook ownership.
  // GET /api/webhooks/ebay-notification?challenge_code=xxx
  app.get('/webhooks/ebay-notification', async (req, reply) => {
    const { challenge_code: challengeCode } = req.query as Record<string, string>
    if (!challengeCode) {
      return reply.status(400).send({ error: 'Missing challenge_code' })
    }

    const token = process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN ?? ''
    const endpoint = process.env.EBAY_NOTIFICATION_ENDPOINT_URL ?? ''

    // eBay challenge response = SHA256(challenge_code + verificationToken + endpoint)
    const hash = crypto
      .createHash('sha256')
      .update(challengeCode + token + endpoint)
      .digest('hex')

    return reply.send({ challengeResponse: hash })
  })

  // POST /api/webhooks/ebay-notification — receives push events from eBay.
  app.post('/webhooks/ebay-notification', {
    config: { rawBody: true },
  }, async (req, reply) => {
    const token = process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN ?? ''
    const body = (req as any).rawBody ?? JSON.stringify(req.body)

    // Verify signature if token is configured. Skip only in dev (no token).
    if (token) {
      const sig = req.headers['x-ebay-signature'] as string | undefined
      if (!verifyEbaySignature(body, sig, token)) {
        logger.warn('[eBay notification] invalid signature')
        return reply.status(204).send()  // eBay requires 204 even on rejection to stop retries
      }
    }

    const payload = req.body as any
    const topic: string = payload?.metadata?.topic ?? ''
    const notifData = payload?.notification?.data ?? payload?.notification ?? {}
    const ebayOrderId: string = notifData.orderId ?? notifData.orderId ?? ''

    logger.info('[eBay notification] received', { topic, ebayOrderId })

    if (!ebayOrderId) {
      return reply.status(204).send()
    }

    if (topic === 'marketplace.order.created') {
      // Trigger an immediate eBay orders sync scoped to last 5 minutes.
      // The service is idempotent on (channel, channelOrderId) so re-running
      // it is safe even if the cron already picked up the same order.
      void (async () => {
        try {
          const connections = await (prisma as any).channelConnection.findMany({
            where: { channelType: 'EBAY', isActive: true },
            select: { id: true },
          })
          const { ebayOrdersService } = await import('../services/ebay-orders.service.js')
          for (const conn of connections) {
            try {
              await ebayOrdersService.syncEbayOrders(conn.id)
            } catch (err) {
              logger.warn('[eBay notification] order sync failed for connection', {
                connectionId: conn.id,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
          logger.info('[eBay notification] order sync complete', { ebayOrderId })
        } catch (err) {
          logger.warn('[eBay notification] order.created handling failed', {
            ebayOrderId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    } else if (topic === 'marketplace.order.cancelled') {
      void (async () => {
        try {
          const order = await prisma.order.findUnique({
            where: {
              channel_channelOrderId: {
                channel: 'EBAY',
                channelOrderId: ebayOrderId,
              },
            },
            select: { id: true, status: true },
          })
          if (!order) {
            logger.info('[eBay notification] order.cancelled for unknown order — skipping', { ebayOrderId })
            return
          }
          if (order.status === 'CANCELLED') {
            logger.info('[eBay notification] order already cancelled — skipping', { ebayOrderId })
            return
          }

          // Mark as cancelled
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
          })

          const { handleOrderCancelled } = await import('../services/order-cancellation/index.js')
          const result = await handleOrderCancelled(order.id)
          logger.info('[eBay notification] cancellation cascade complete', { ebayOrderId, ...result })
        } catch (err) {
          logger.warn('[eBay notification] order.cancelled handling failed', {
            ebayOrderId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    } else {
      logger.info('[eBay notification] unhandled topic', { topic })
    }

    // eBay expects 204 for successful receipt — always return quickly.
    return reply.status(204).send()
  })
}
