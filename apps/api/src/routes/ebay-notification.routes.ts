/**
 * IS.2 — eBay Notification Platform push webhook + Trading API subscription setup.
 *
 * Receives real-time push events from eBay's Platform Notifications for:
 *   - AuctionCheckoutComplete  → order sold via auction
 *   - FixedPriceTransaction    → order sold via Buy It Now / fixed price
 *
 * Admin setup endpoint:
 *   POST /api/admin/setup-ebay-notifications
 *   Calls SetNotificationPreferences via Trading API to subscribe the seller
 *   account to the two order-completion events. Site 101 (Italy). One-time,
 *   idempotent. Uses EBAY_APP_ID / EBAY_CERT_ID / EBAY_DEV_ID / EBAY_TOKEN.
 *
 * Challenge endpoint (ownership verification):
 *   GET /api/webhooks/ebay-notification?challenge_code=xxx
 *   Returns SHA256(challenge_code + verificationToken + endpointUrl).
 *
 * Push webhook:
 *   POST /api/webhooks/ebay-notification
 *   Verifies X-EBAY-SIGNATURE, processes order events.
 */

import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

// ── Trading API helpers ────────────────────────────────────────────────

function tradingCredentialsMissing(): string | null {
  // Uses the same env var names as EbayAuthService (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)
  const required = ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_DEV_ID']
  const missing = required.filter((k) => !process.env[k])
  return missing.length ? missing.join(', ') : null
}

/** Resolve a fresh OAuth access token from the first active eBay ChannelConnection. */
async function resolveEbayAccessToken(): Promise<string> {
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })
  if (!connection) throw new Error('No active eBay ChannelConnection found — complete OAuth first')
  const { EbayAuthService } = await import('../services/ebay-auth.service.js')
  const authService = new EbayAuthService()
  return authService.getValidToken(connection.id)
}

async function callTradingApi(callName: string, xmlBody: string): Promise<{
  ack: string
  shortMessage?: string
  longMessage?: string
  rawXml: string
}> {
  const compatLevel = process.env.EBAY_COMPAT_LEVEL ?? '1193'
  const isSandbox = process.env.EBAY_ENVIRONMENT === 'sandbox' || process.env.EBAY_SANDBOX === 'true'
  const endpoint = isSandbox
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME':            callName,
      'X-EBAY-API-COMPATIBILITY-LEVEL':  compatLevel,
      'X-EBAY-API-DEV-NAME':             process.env.EBAY_DEV_ID!,
      'X-EBAY-API-APP-NAME':             process.env.EBAY_CLIENT_ID!,   // App ID
      'X-EBAY-API-CERT-NAME':            process.env.EBAY_CLIENT_SECRET!, // Cert ID
      'X-EBAY-API-SITEID':               '101',  // Italy
      'Content-Type':                    'text/xml',
    },
    body: xmlBody,
  })

  const rawXml = await res.text()
  if (!res.ok) {
    throw new Error(`eBay ${callName} HTTP ${res.status}: ${rawXml.slice(0, 300)}`)
  }

  const ack = rawXml.match(/<Ack>([^<]+)<\/Ack>/)?.[1] ?? 'Unknown'
  const shortMessage = rawXml.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1]
  const longMessage  = rawXml.match(/<LongMessage>([^<]+)<\/LongMessage>/)?.[1]

  return { ack, shortMessage, longMessage, rawXml }
}

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

  // ── GET /api/admin/ebay-token-status ──────────────────────────────
  // Shows the current access-token expiry for every active eBay connection.
  app.get('/admin/ebay-token-status', async (_req, reply) => {
    const connections = await prisma.channelConnection.findMany({
      where: { channelType: 'EBAY', isActive: true },
      select: {
        id: true,
        ebaySignInName: true,
        tokenExpiresAt: true,
        ebayTokenExpiresAt: true,
        refreshToken: true,
        ebayRefreshToken: true,
        lastSyncStatus: true,
        lastSyncError: true,
      },
    })

    const now = new Date()
    return reply.send({
      now: now.toISOString(),
      connections: connections.map((c) => {
        const expiresAt = c.tokenExpiresAt ?? c.ebayTokenExpiresAt
        const hasRefreshToken = !!(c.refreshToken ?? c.ebayRefreshToken)
        const minsUntilExpiry = expiresAt
          ? Math.round((expiresAt.getTime() - now.getTime()) / 60_000)
          : null
        return {
          id: c.id,
          signInName: c.ebaySignInName,
          tokenExpiresAt: expiresAt?.toISOString() ?? null,
          minsUntilExpiry,
          expired: minsUntilExpiry !== null ? minsUntilExpiry <= 0 : null,
          hasRefreshToken,
          lastSyncStatus: c.lastSyncStatus,
          lastSyncError: c.lastSyncError,
        }
      }),
    })
  })

  // ── POST /api/admin/refresh-ebay-tokens ───────────────────────────
  // Triggers an immediate token refresh for all active eBay connections.
  // Same logic as the 30-min cron — safe to call any time.
  app.post('/admin/refresh-ebay-tokens', async (_req, reply) => {
    const { runRefreshSweep } = await import('../jobs/ebay-token-refresh.job.js')
    try {
      await runRefreshSweep()
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }

    // Return updated state immediately after refresh
    const connections = await prisma.channelConnection.findMany({
      where: { channelType: 'EBAY', isActive: true },
      select: {
        id: true,
        ebaySignInName: true,
        tokenExpiresAt: true,
        ebayTokenExpiresAt: true,
        lastSyncStatus: true,
        lastSyncError: true,
      },
    })
    const now = new Date()
    return reply.send({
      ok: true,
      refreshedAt: now.toISOString(),
      connections: connections.map((c) => {
        const expiresAt = c.tokenExpiresAt ?? c.ebayTokenExpiresAt
        const minsUntilExpiry = expiresAt
          ? Math.round((expiresAt.getTime() - now.getTime()) / 60_000)
          : null
        return {
          id: c.id,
          signInName: c.ebaySignInName,
          tokenExpiresAt: expiresAt?.toISOString() ?? null,
          minsUntilExpiry,
          lastSyncStatus: c.lastSyncStatus,
          lastSyncError: c.lastSyncError,
        }
      }),
    })
  })

  // ── POST /api/admin/setup-ebay-notifications ───────────────────────
  // Calls SetNotificationPreferences via Trading API to subscribe the
  // production seller account (site 101 — Italy) to:
  //   - AuctionCheckoutComplete  (auction BIN / true auction checkout)
  //   - FixedPriceTransaction    (fixed-price / Buy It Now sale)
  // Idempotent: re-running overwrites existing preferences safely.
  app.post('/admin/setup-ebay-notifications', async (_req, reply) => {
    const missing = tradingCredentialsMissing()
    if (missing) {
      return reply.status(400).send({
        error: `Missing Trading API credentials: ${missing}`,
        hint: 'Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_DEV_ID in Railway env vars',
      })
    }

    let token: string
    try {
      token = await resolveEbayAccessToken()
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? String(err) })
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <ApplicationDeliveryPreferences>
    <ApplicationEnable>Enable</ApplicationEnable>
    <AlertEnable>Enable</AlertEnable>
  </ApplicationDeliveryPreferences>
  <UserDeliveryPreferenceArray>
    <NotificationEnable>
      <EventType>AuctionCheckoutComplete</EventType>
      <EventEnable>Enable</EventEnable>
    </NotificationEnable>
    <NotificationEnable>
      <EventType>FixedPriceTransaction</EventType>
      <EventEnable>Enable</EventEnable>
    </NotificationEnable>
  </UserDeliveryPreferenceArray>
</SetNotificationPreferencesRequest>`

    try {
      const result = await callTradingApi('SetNotificationPreferences', xml)
      logger.info('[eBay setup] SetNotificationPreferences', { ack: result.ack, shortMessage: result.shortMessage })

      if (result.ack === 'Failure') {
        return reply.status(502).send({
          ok: false,
          ack: result.ack,
          error: result.shortMessage ?? 'eBay returned Failure',
          detail: result.longMessage,
          rawXml: result.rawXml,
        })
      }

      return reply.send({
        ok: true,
        ack: result.ack,
        message: 'Subscribed to AuctionCheckoutComplete + FixedPriceTransaction on site 101 (Italy)',
        warning: result.ack === 'Warning' ? result.shortMessage : undefined,
      })
    } catch (err: any) {
      logger.error('[eBay setup] SetNotificationPreferences failed', { error: err?.message })
      return reply.status(500).send({ ok: false, error: err?.message ?? String(err) })
    }
  })

  // ── GET /api/admin/ebay-notification-status ────────────────────────
  // Calls GetNotificationPreferences to verify the subscription is live.
  app.get('/admin/ebay-notification-status', async (_req, reply) => {
    const missing = tradingCredentialsMissing()
    if (missing) {
      return reply.status(400).send({ error: `Missing Trading API credentials: ${missing}` })
    }

    let token: string
    try {
      token = await resolveEbayAccessToken()
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? String(err) })
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <PreferenceLevel>User</PreferenceLevel>
</GetNotificationPreferencesRequest>`

    try {
      const result = await callTradingApi('GetNotificationPreferences', xml)
      return reply.send({
        ack: result.ack,
        rawXml: result.rawXml,
      })
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── GET /api/webhooks/ebay-notification?challenge_code=xxx ─────────
  // eBay challenge endpoint — required to verify webhook ownership.
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
