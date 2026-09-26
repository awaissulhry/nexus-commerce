import { legacyIngress, verifiedChannelWorkspace, withIngressWorkspace } from '../lib/workspace-ingress.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * eBay inbound notifications — the receiver, the ownership challenge, and setup.
 *
 * P2.3 rewrote the setup half. It used to call `SetNotificationPreferences`, eBay's OLD
 * delivery system, while the receiver branched on REST-looking topic names that eBay
 * does not use. Nothing joined the two: there was no Notification API destination and
 * no subscription, so **no genuine eBay notification had ever arrived**. Every EBAY row
 * in the inbound ledger is one of this repository's own probes.
 *
 * Endpoints:
 *   POST /api/admin/setup-ebay-notifications   create the destination, subscribe the
 *                                              real topics, report any name eBay's own
 *                                              catalogue does not contain
 *   GET  /api/admin/ebay-notification-status   what eBay says exists right now
 *   GET  /api/webhooks/ebay-notification?challenge_code=…
 *                                              ownership check —
 *                                              SHA256(code + token + endpoint)
 *   POST /api/webhooks/ebay-notification       the receiver. Verifies X-EBAY-SIGNATURE,
 *                                              records every arrival and every
 *                                              rejection, then routes by topic.
 *
 * The lifecycle topics (account deletion, authorization revocation) are answered BEFORE
 * account routing — see the comment at that branch; routing them was returning 503 on
 * the one topic eBay requires a 200 for.
 */

import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { registerRawJsonParser } from '../utils/webhook.js'
import type { RawBodyRequest } from '../utils/webhook.js'
import { resolveConnection, tryResolveConnection, listActiveConnections } from '../services/connection-resolver.service.js'
import { verifyEbayNotification, ebayChallengeResponse } from '../services/cx/ingress/ebay-signature.js'
import { ebayTopicAction } from '../services/cx/ingress/ebay-topics.js'
import { recordInbound } from '../services/cx/ingress/ledger.js'

// P2.3 — the Trading API helpers that stood here are gone.
//
// `tradingCredentialsMissing`, `resolveEbayAccessToken` and `callTradingApi` existed
// only to drive `SetNotificationPreferences` and `GetNotificationPreferences`, eBay's
// OLD notification system. Both routes now read and write the Notification API
// instead, so all three were dead. The eBay Trading API itself is untouched and still
// lives in services/ebay-trading-api.service.ts — only this file's private copies of
// the plumbing are removed.

// P4 — legacy Trading-API sale topics.
//
// P2.3 — the comment here used to say these are "what setup-ebay-notifications
// subscribes to". That route no longer subscribes anything through the Trading API, so
// these arrive only if the old delivery preferences are still configured in eBay's
// developer portal from before. The branch stays because it works and costs nothing
// when nothing arrives; removing it would drop real sales if those preferences are
// still live.
//
// They are deliberately NOT in the topic table: `ItemSold` (Trading) and `ITEM_SOLD`
// (Notification API) are different strings for different systems, and folding them
// together would make one sale fire two syncs.
//
// Module-scope so the hot webhook handler doesn't re-allocate per request.
const LEGACY_SALE_TOPICS = new Set([
  'AuctionCheckoutComplete',
  'FixedPriceTransaction',
  'ItemSold',
])

export default async function ebayNotificationRoutes(app: FastifyInstance): Promise<void> {
  // CX.0 (S9): eBay signs the raw bytes; capture them for this plugin only.
  registerRawJsonParser(app)

  // ── GET /api/admin/ebay-token-status ──────────────────────────────
  // Shows the current access-token expiry for every active eBay connection.
  app.get('/admin/ebay-token-status', async (_req, reply) => {
    // MAP.3 — a token-status page genuinely wants EVERY account.
    const connections = (await listActiveConnections('EBAY')).map((c) => ({
      id: c.id,
      ebaySignInName: c.ebaySignInName,
      tokenExpiresAt: c.tokenExpiresAt,
      ebayTokenExpiresAt: c.ebayTokenExpiresAt,
      authStatus: c.authStatus,
      refreshTokenExpiresAt: c.refreshTokenExpiresAt,
      credentialsKeyId: c.credentialsKeyId,
      lastSyncStatus: c.lastSyncStatus,
      lastSyncError: c.lastSyncError,
    }))

    const now = new Date()
    return reply.send({
      now: now.toISOString(),
      connections: connections.map((c) => {
        const expiresAt = c.tokenExpiresAt ?? c.ebayTokenExpiresAt
        // CX.1 — the row no longer carries tokens; an envelope exists iff credentialsKeyId is set,
        // and the refresh token is live iff its expiry (eBay: ~18 months) is in the future.
        const hasRefreshToken = !!c.credentialsKeyId && (c.refreshTokenExpiresAt ? c.refreshTokenExpiresAt > now : true)
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
          authStatus: c.authStatus,
          refreshTokenExpiresAt: c.refreshTokenExpiresAt?.toISOString() ?? null,
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
    const { runHeartbeatSweep: runRefreshSweep } = await import('../jobs/cx-heartbeat.job.js')
    try {
      await runRefreshSweep()
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }

    // Return updated state immediately after refresh
    // MAP.3 — a token-status page genuinely wants EVERY account.
    const connections = (await listActiveConnections('EBAY')).map((c) => ({
      id: c.id,
      ebaySignInName: c.ebaySignInName,
      tokenExpiresAt: c.tokenExpiresAt,
      ebayTokenExpiresAt: c.ebayTokenExpiresAt,
      lastSyncStatus: c.lastSyncStatus,
      lastSyncError: c.lastSyncError,
    }))
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
  // P2.3 — the Trading API setup that stood here is retired.
  //
  // `SetNotificationPreferences` is eBay's OLD delivery system, and its own comments
  // recorded the confusion: someone had put REST topic names into it and eBay answered
  // "Invalid input data", then `ItemRevised` was refused too, and the note concluded
  // that returns and refunds "flow through the REST Notification API instead, which we
  // already handle". Nothing handled them. There was no destination and no
  // subscription, so **no genuine eBay notification had ever arrived** — every EBAY row
  // in the ledger is one of this repository's own probes.
  //
  // This route now does the thing that was missing: create the destination eBay
  // delivers to, and subscribe the real topics, checked against eBay's own catalogue.
  app.post('/admin/setup-ebay-notifications', async (req, reply) => {
    const { setupEbayNotifications, ebayNotificationSetupSucceeded } = await import('../services/cx/connectors/ebay/notifications.js')
    const query = req.query as { environment?: string; onlyHandled?: string }
    const environment = query.environment === 'sandbox' ? 'sandbox' : 'production'
    const result = await setupEbayNotifications({
      environment,
      // Default: subscribe only the topics Nexus can act on. A topic with no handler
      // would arrive, be recorded and then dead-letter (P2.1) — visible, but noise.
      skipTopicsWithoutHandlers: true,
    })
    if (!result.configured) {
      return reply.status(400).send({ ok: false, ...result })
    }
    // A wrong topic id is reported as its own thing, not folded into "failed". It is
    // the finding this package exists to surface.
    return reply.send({
      ok: ebayNotificationSetupSucceeded(result),
      ...result,
      hint: result.notOffered.length
        ? `eBay's catalogue does not contain: ${result.notOffered.join(', ')}. Correct them in services/cx/ingress/ebay-topics.ts.`
        : undefined,
    })
  })

  // ── GET /api/admin/ebay-notification-status ────────────────────────
  //
  // P2.3 — reads the Notification API, not `GetNotificationPreferences`.
  //
  // The Trading-API answer this used to return could only ever describe the OLD
  // delivery system, so it reported healthy preferences for a path nothing listened on
  // while the REST destination — the one eBay would actually deliver to — did not
  // exist. A status endpoint that cannot see the thing that is broken is worse than
  // none, because it is quoted.
  app.get('/admin/ebay-notification-status', async (req, reply) => {
    const {
      getEbayTopics, getEbayDestinations, getEbaySubscriptions, EBAY_DESIRED_TOPICS,
    } = await import('../services/cx/connectors/ebay/notifications.js')
    const query = req.query as { environment?: string }
    const environment = query.environment === 'sandbox' ? 'sandbox' : 'production'
    /**
     * 🔴 CX — through `ebayNotificationConfig()`, the SAME accessor the challenge handler
     * below and the destination setup use.
     *
     * This line read `process.env.EBAY_NOTIFICATION_ENDPOINT` while every other reader
     * reads `EBAY_NOTIFICATION_ENDPOINT_URL` — the exact two-names-for-one-fact drift
     * that `notifications.ts` fixed in itself and documented as *"the shape of every
     * drift defect in this programme"*. It was missed here.
     *
     * What it cost: `endpoint` came back **null** in production, so
     * `destinations.find(d => d.endpoint === endpoint)` compared every real destination
     * against `null`, matched nothing, and reported `destination: null` — whether or not
     * a destination existed. This file's own header says a status endpoint that cannot
     * see the thing that is broken is worse than none, because it is quoted. It was
     * quoted: `PROGRESS.md` §4 sends the next session here.
     */
    const { ebayNotificationConfig, ebayVerificationTokenError } = await import('../services/cx/connectors/ebay/notifications.js')
    const config = ebayNotificationConfig()
    const endpoint = config.endpoint
    try {
      const [topics, destinations, subscriptions] = await Promise.all([
        getEbayTopics(environment), getEbayDestinations(environment), getEbaySubscriptions(environment),
      ])
      const offered = new Set(topics.map((t) => t.topicId))
      const ours = endpoint ? destinations.find((d) => d.endpoint === endpoint) ?? null : null
      return reply.send({
        environment,
        endpoint,
        /**
         * Whether the two variables the ownership hash is built from are set at all.
         * Without this, a null `endpoint` reads as "eBay has nothing" when it means
         * "we did not ask for anything".
         */
        configured: {
          hasEndpoint: !!config.endpoint, hasVerificationToken: !!config.verificationToken,
          verificationTokenValid: !ebayVerificationTokenError(config.verificationToken),
        },
        configurationError: ebayVerificationTokenError(config.verificationToken),
        destination: ours,
        /**
         * 🔴 "Could not measure" is not "measured empty". `destination: null` alone
         * cannot tell a seller with no destination from a lookup that had nothing to
         * look for, so the raw count and the endpoints eBay holds are reported beside it.
         */
        destinationsAtEbay: destinations.length,
        destinationEndpoints: destinations.map((d) => d.endpoint),
        // The number that matters: a subscription pointed anywhere but our destination
        // delivers into the void, the same failure RT.3 found on the Amazon side.
        subscriptions: subscriptions.map((s) => ({
          ...s, pointsAtOurDestination: !!ours && s.destinationId === ours.destinationId,
        })),
        catalogueSize: offered.size,
        /**
         * Every topic id eBay actually offers. A wish with `offeredByEbay: false` means
         * OUR id is wrong, and the fix is to READ the right one here — never to invent a
         * plausible one. P6.7 records what inventing eBay strings costs: two made-up
         * scope names broke every eBay connect for nineteen days.
         */
        catalogue: topics.map((t) => t.topicId).sort(),
        wanted: EBAY_DESIRED_TOPICS.map((t) => ({
          ...t,
          offeredByEbay: offered.has(t.topicId),
          subscribed: subscriptions.some((s) => s.topicId === t.topicId && (!ours || s.destinationId === ours.destinationId)),
        })),
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

    // P2.3 — through the one accessor the destination setup also uses, so the hash eBay
    // computes from the destination and the hash we answer with cannot be built from
    // two different pairs of environment variables.
    const { ebayNotificationConfig } = await import('../services/cx/connectors/ebay/notifications.js')
    const config = ebayNotificationConfig()
    const token = config.verificationToken ?? ''
    const endpoint = config.endpoint ?? ''

    // CX.4a — an unset token or endpoint still produces a well-formed hash, and it is
    // the WRONG hash. eBay reads that as a failed ownership check and marks the
    // endpoint down after 24 hours, taking every topic with it. Answering anyway is
    // right (silence fails too), but it must not be silent to us.
    if (!token || !endpoint) {
      logger.error('[eBay notification] challenge answered with an incomplete configuration', {
        hasToken: Boolean(token),
        hasEndpoint: Boolean(endpoint),
      })
    }

    // SHA256(challenge_code + verificationToken + endpoint), hex.
    return reply.send({ challengeResponse: ebayChallengeResponse(challengeCode, token, endpoint) })
  })

  // POST /api/webhooks/ebay-notification — receives push events from eBay.
  app.post('/webhooks/ebay-notification', async (req, reply) => {
    const body = (req as RawBodyRequest).rawBody

    if (!body) {
      return reply.status(400).send({ error: 'raw body unavailable' })
    }

    // CX.4a — eBay's real scheme: an ECC signature over the payload, verified with a
    // public key fetched by the key id in the header. What stood here checked an
    // HMAC of the verification token, which eBay never sends, so every genuine
    // notification failed it. Still fail-closed: an unfetchable key is a rejection.
    const sig = req.headers['x-ebay-signature'] as string | undefined
    const verdict = await verifyEbayNotification({ rawBody: body, header: sig })
    if (!verdict.ok) {
      // The old path returned 204 and wrote nothing, so a rejected notification and a
      // notification that never arrived were indistinguishable afterwards. Record it.
      const rejected = req.body as any
      const claimedId = rejected?.metadata?.notificationId ?? null
      // P2.1 — this write used to be skipped whenever business profiles were on,
      // which is how production runs. So the one mode where a rejected notification
      // mattered was the one mode that recorded nothing, and `signatureOk = false`
      // could not occur in production however many forged notifications arrived.
      //
      // The reason it was switched off rather than fixed is real: an unverified body
      // names no seller, so there is no workspace to route it to and the write threw.
      // The platform's own workspace is the honest home for it — the same choice the
      // Amazon credential path makes for a message no business owns. It is also the
      // only safe one: attributing an unverified body to a business would let anyone
      // who can reach the endpoint write rows into that business's ledger.
      await legacyIngress(() => recordInbound({
        channel: 'EBAY',
        eventType: rejected?.metadata?.topic ?? 'unverified',
        // NOT the notificationId the payload claims. Nothing about an unverified
        // body is trustworthy, and `(channel, externalId)` is a UNIQUE key: a forged
        // notification naming a real id would sit in that slot and make the genuine
        // delivery look like a duplicate, suppressing it. Passing null keys the row on
        // the body digest instead, which no attacker can use to collide with a
        // verified event. The claimed id is still kept — in the payload and in the
        // reason — it just cannot occupy the identity.
        externalId: null,
        rawBody: body,
        payload: rejected ?? {},
        signatureOk: false,
        verifiedBy: 'ebay_ecdsa',
        status: 'failed',
        lastError: `signature rejected: ${verdict.reason}${verdict.kid ? ` (kid ${verdict.kid})` : ''}${claimedId ? ` (claimed id ${String(claimedId).slice(0, 60)})` : ''}`,
      }))
      logger.warn('[eBay notification] signature rejected', { reason: verdict.reason, kid: verdict.kid })
      // 412 is what eBay's own SDK answers on a failed check. The 204 that stood here
      // told eBay the notification had been accepted.
      return reply.status(412).send({ error: 'signature verification failed' })
    }

    const processVerified = async () => {
    const payload = req.body as any
    const topic: string = payload?.metadata?.topic ?? ''
    const notifData = payload?.notification?.data ?? payload?.notification ?? {}
    const ebayOrderId: string = notifData.orderId ?? notifData.orderId ?? ''
    const notificationId: string =
      payload?.metadata?.notificationId ?? payload?.notification?.notificationId ?? ''
    // P2.3 — one topic table (services/cx/ingress/ebay-topics.ts) instead of four topic
    // strings written inline here, three of which were not eBay topic ids at all.
    const { action: topicAction, via: topicVia } = ebayTopicAction(topic, payload)

    logger.info('[eBay notification] received', { topic, ebayOrderId })

    // RT.1 — persist the receipt as a WebhookEvent so push-health and
    // /sync-logs/webhooks can see eBay traffic. externalId prefers
    // eBay's notificationId; if missing we fall back to a deterministic
    // composite so the unique (channel, externalId) constraint still
    // bounces duplicate retries from eBay.
    //
    // RT.3 — eBay's notification envelope carries metadata.publishDate
    // (the moment eBay queued the notification). Capture it as
    // providerTimestamp so /api/admin/push-latency can chart eBay
    // push latency alongside Amazon + Shopify.
    const externalId = notificationId || `${topic}:${ebayOrderId}:${Date.now()}`
    const publishDateRaw = payload?.metadata?.publishDate ?? null
    const providerTimestamp =
      typeof publishDateRaw === 'string' && !Number.isNaN(Date.parse(publishDateRaw))
        ? new Date(publishDateRaw)
        : null
    // CX.4a — through the shared ledger writer, so an accepted notification and a
    // rejected one are the same kind of record and can be counted together.
    // `recordInbound` swallows its own failures for the reason the old try/catch
    // gave: eBay retries forever if we stop answering.
    await recordInbound({
      channel: 'EBAY',
      eventType: topic || 'unknown',
      externalId: externalId || null,
      rawBody: body,
      payload: payload ?? {},
      signatureOk: true,
      verifiedBy: 'ebay_ecdsa',
      status: 'done',
      providerTimestamp,
    })

    // MARKETPLACE_ACCOUNT_DELETION — eBay's erasure notice, and a condition of
    // holding production keys. Acknowledging it is mandatory and is done here.
    // Carrying out the erasure is NOT done here: it deletes real customer data, so it
    // is the Owner's decision and its own unit, and doing it as a side effect of an
    // inbound message would be the most destructive thing in this codebase.
    // Logged at error level so it cannot pass unseen while that decision is pending.
    if (topicAction === 'account_deletion') {
      logger.error('[eBay notification] MARKETPLACE_ACCOUNT_DELETION received — acknowledged and recorded; erasure is NOT automated', {
        notificationId: notificationId || null,
        username: notifData?.username ?? null,
      })
      return reply.status(200).send()
    }

    // RT.10 — ItemRevised carries quantity changes (operator edits in
    // eBay UI, batch upload via API, third-party stock app). Each
    // change becomes one ChannelStockEvent so /fulfillment/stock/
    // channel-drift surfaces the drift in ~30s instead of waiting
    // for the CS-series eBay ingester sweep.
    //
    // Topic shapes seen:
    //   Trading API (legacy): ItemRevised (XML notification)
    //   REST notification API: marketplace.inventory_item.updated
    if (topicAction === 'listing_changed') {
      void (async () => {
        try {
          const data = payload?.notification?.data ?? payload?.notification ?? payload
          // Trading API ItemRevised → ItemID + Quantity
          // REST inventory → sku + availability
          const sku: string =
            data?.sku ??
            data?.SKU ??
            data?.Item?.SKU ??
            data?.itemSku ??
            ''
          const qty = Number(
            data?.availability?.shipToLocationAvailability?.quantity ??
              data?.Item?.Quantity ??
              data?.Quantity ??
              data?.quantity ??
              -1,
          )
          if (!sku || qty < 0) {
            logger.info('[eBay notification] item revision missing sku/qty — skipping', {
              topic,
              sku,
              qty,
            })
            return
          }
          const { recordChannelStockEvent } = await import(
            '../services/channel-stock-event.service.js'
          )
          await recordChannelStockEvent({
            channel: 'EBAY',
            channelEventId: externalId,
            sku,
            channelReportedQty: qty,
            rawPayload: data,
          })
          logger.info('[eBay notification] item revision recorded', { sku, qty })
        } catch (err) {
          logger.warn('[eBay notification] item revision handler failed', {
            topic,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
      return reply.status(204).send()
    }

    // P4 — legacy Trading-API sale notifications (AuctionCheckoutComplete /
    // FixedPriceTransaction / ItemSold) are exactly what setup-ebay-notifications
    // subscribes to, but they don't carry a REST `orderId`, so without this they'd
    // fall through the `!ebayOrderId` guard below and never drive ingestion —
    // eBay sales would only decrement stock on the 15-min poll. Trigger the same
    // idempotent recent-window sync the REST `marketplace.order.created` branch
    // uses, so a sale decrements stock in real time on the legacy path too.
    if (LEGACY_SALE_TOPICS.has(topic)) {
      void (async () => {
        try {
          // MAP.3 — a sale notification does not say which account it belongs to,
          // so every account is polled and the idempotent order service dedupes.
          // That is correct for N accounts, and it is what the loop below already did.
          const connections = await listActiveConnections('EBAY')
          const { ebayOrdersService } = await import('../services/ebay-orders.service.js')
          for (const conn of connections) {
            try {
              // RT.3 — the notification is about an order from moments ago;
              // a 30-min ranged sync ingests it in one page instead of the
              // old full 7-day resync per webhook (idempotent either way).
              await ebayOrdersService.syncEbayOrdersInRange(
                conn.id,
                new Date(Date.now() - 30 * 60_000),
                new Date(Date.now() + 60_000),
              )
            } catch (err) {
              logger.warn('[eBay notification] legacy-sale order sync failed for connection', {
                connectionId: conn.id,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
          logger.info('[eBay notification] legacy sale notification → order sync complete', { topic })
        } catch (err) {
          logger.warn('[eBay notification] legacy-sale handling failed', {
            topic,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
      return reply.status(204).send()
    }

    if (!ebayOrderId) {
      return reply.status(204).send()
    }

    if (topicAction === 'order_created') {
      // Trigger an immediate eBay orders sync scoped to a short window.
      // The service is idempotent on (channel, channelOrderId) so re-running
      // it is safe even if the cron already picked up the same order.
      void (async () => {
        try {
          // MAP.3 — a sale notification does not say which account it belongs to,
          // so every account is polled and the idempotent order service dedupes.
          // That is correct for N accounts, and it is what the loop below already did.
          const connections = await listActiveConnections('EBAY')
          const { ebayOrdersService } = await import('../services/ebay-orders.service.js')
          for (const conn of connections) {
            try {
              // RT.3 — ranged (30-min) instead of the full 7-day resync.
              await ebayOrdersService.syncEbayOrdersInRange(
                conn.id,
                new Date(Date.now() - 30 * 60_000),
                new Date(Date.now() + 60_000),
              )
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
    } else if (topicAction === 'order_cancelled') {
      void (async () => {
        try {
          const order = await prisma.order.findUnique({
            where: {
              channel_channelOrderId: workspaceKey({
                channel: 'EBAY',
                channelOrderId: ebayOrderId,
              }),
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
    } else if (topicAction === 'authorization_revoked') {
      // P2.6 — act on it.
      //
      // The notification names the eBay USERNAME, not the user id the connection is
      // keyed by, so P2.6's migration added the username to `inboundAliases` and the
      // routing index answers with the exact connection. That matters more here than
      // anywhere: a revoke that has to work out WHICH account it means cuts off the
      // wrong seller the day a second one is connected, and this endpoint is reachable
      // by anyone who can forge a signature — which is why the revoke only happens on
      // the VERIFIED path, inside the routed workspace.
      const revokedUser = String(notifData?.username ?? notifData?.userId ?? '')
      await (async () => {
        try {
          const target = await verifiedChannelWorkspace('EBAY', revokedUser || undefined)
          const { revokeChannelConnection } = await import('../services/cx/account-lifecycle.service.js')
          const outcome = await withIngressWorkspace(target.workspaceId, () =>
            revokeChannelConnection(
              target.connectionId,
              `eBay reported AUTHORIZATION_REVOCATION for ${revokedUser || 'this seller'}.`,
              'ebay_authorization_revocation',
            ),
          )
          logger.error('[eBay notification] AUTHORIZATION_REVOCATION — the account is revoked and writes are held', {
            notificationId: notificationId || null, username: revokedUser || null,
            connectionId: target.connectionId, outcome: outcome.skipped ?? 'revoked',
          })
        } catch (error) {
          // Recorded, never thrown: eBay must still get its 204, and the ledger row
          // already holds the payload for an operator to act on by hand.
          logger.error('[eBay notification] AUTHORIZATION_REVOCATION could not be attributed to a connection', {
            notificationId: notificationId || null, username: revokedUser || null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    } else {
      // `topicVia` matters as much as the topic: 'none' means nothing in the payload
      // identified it either, which is the only case that is genuinely unhandled.
      logger.info('[eBay notification] unhandled topic', { topic, via: topicVia })
    }

    // eBay expects 204 for successful receipt — always return quickly.
    return reply.status(204).send()
    }
    if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return processVerified()
    const event = req.body as any

    // P2.3 — the lifecycle topics are answered BEFORE any account routing, and this is
    // not a tidiness point.
    //
    // MARKETPLACE_ACCOUNT_DELETION carries a `username`, never a seller object, so the
    // seller extraction below yields undefined and `verifiedChannelWorkspace('EBAY')`
    // is left to pick one row out of however many eBay accounts are connected. With
    // two it raises `ingress_account_ambiguous` and the endpoint answers **503**.
    // Measured, with a control: no seller id -> throws 503; a known seller id ->
    // resolves. eBay requires a 200 for this topic, marks an endpoint that fails it as
    // down, and answering it is a condition of holding production keys — so the more
    // eBay accounts are connected, the more certainly the erasure notice is refused.
    //
    // AUTHORIZATION_REVOCATION has the same shape: it is about the grant, not about an
    // order, so it cannot name a seller to route by either.
    //
    // Both are handled in the platform's own workspace, which is the honest home for a
    // notification no single business owns — the same choice the rejected-signature row
    // above makes.
    const lifecycle = ebayTopicAction(event?.metadata?.topic, event).action
    if (lifecycle === 'account_deletion' || lifecycle === 'authorization_revoked') {
      return await legacyIngress(processVerified)
    }

    const data = event?.notification?.data
    const seller = data?.seller?.userId ?? data?.sellerUser?.userId ?? data?.user?.userId ?? data?.sellerId
    try {
      const route = await verifiedChannelWorkspace('EBAY', typeof seller === 'string' ? seller : undefined)
      return await withIngressWorkspace(route.workspaceId, processVerified)
    } catch (error) {
      logger.error('[eBay notification] verified event needs account routing', { error: error instanceof Error ? error.message : String(error) })
      return reply.code(503).send({ error: 'Notification account could not be resolved.' })
    }

  })
}
