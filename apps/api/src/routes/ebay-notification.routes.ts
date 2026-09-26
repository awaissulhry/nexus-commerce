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
 *                                              armed topics, report any name eBay's own
 *                                              catalogue does not contain (403 unarmed)
 *   POST /api/admin/ebay-notification-test?topicId=…
 *                                              ask eBay to send its test notice for our
 *                                              subscription to an armed topic (403 unarmed)
 *   GET  /api/admin/ebay-notification-status   what eBay says exists right now, plus the
 *                                              local token check and the arming gate
 *   GET  /api/webhooks/ebay-notification?challenge_code=…
 *                                              ownership check —
 *                                              SHA256(code + token + endpoint)
 *   POST /api/webhooks/ebay-notification       the receiver. Verifies X-EBAY-SIGNATURE,
 *                                              records every arrival and every
 *                                              rejection, then routes by topic.
 *
 * The receiver acknowledges only a durable verified receipt/quarantine. Business
 * effects run through the stored-receipt processor; unknown topics remain visible
 * and recoverable. A successful acknowledgement does not claim successful erasure.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { logger } from '../utils/logger.js'
import { auditLogService } from '../services/audit-log.service.js'
import { registerRawJsonParser } from '../utils/webhook.js'
import type { RawBodyRequest } from '../utils/webhook.js'
import { listActiveConnections } from '../services/connection-resolver.service.js'
import { ebayChallengeResponse } from '../services/cx/ingress/ebay-signature.js'
import { receiveEbayNotice, EbayAdmissionError } from '../services/cx/ingress/ebay-admission.js'

// P2.3 — the Trading API helpers that stood here are gone.
//
// `tradingCredentialsMissing`, `resolveEbayAccessToken` and `callTradingApi` existed
// only to drive `SetNotificationPreferences` and `GetNotificationPreferences`, eBay's
// OLD notification system. Both routes now read and write the Notification API
// instead, so all three were dead. The eBay Trading API itself is untouched and still
// lives in services/ebay-trading-api.service.ts — only this file's private copies of
// the plumbing are removed.

/**
 * One AuditLog row per admin setup or test-notice request, refusals included: who asked,
 * which topics were armed, and what happened. Metadata carries no secret: eBay error text is
 * already redacted in notifications.ts. Fail-open, like every audit writer here.
 */
async function auditEbayNotificationAction(req: FastifyRequest, action: 'ebay.notification.setup' | 'ebay.notification.test', environment: string, metadata: {
  outcome: string; topics: string[]; destinationId?: string | null; perTopic?: Array<{ topicId: string; status: string }>; subscriptionId?: string; error?: string
}): Promise<void> {
  await auditLogService.write({
    userId: req.authUser?.id ?? null,
    ip: req.ip ?? null,
    entityType: 'EbayNotificationSetup',
    entityId: `ebay-notifications:${environment}`,
    action,
    metadata: { source: 'ebay-notification-admin', environment, ...metadata, ...(metadata.error ? { error: metadata.error.slice(0, 500) } : {}) },
  })
}

export default async function ebayNotificationRoutes(app: FastifyInstance): Promise<void> {
  // CX.0 (S9): eBay signs the raw bytes; capture them for this plugin only.
  registerRawJsonParser(app, { rawBodyOnly: request => request.method === 'POST' && request.routeOptions.url.endsWith('/webhooks/ebay-notification') })

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
  //
  // S1 (review, 2026-09-26): this route used to ignore the setup switch. It now obeys the
  // same arming gate as the nightly reconcile, and answers 403 before any eBay call.
  app.post('/admin/setup-ebay-notifications', async (req, reply) => {
    const { setupEbayNotifications, ebayNotificationSetupSucceeded, ebayNotificationSetupGate, EbayNotificationNotArmedError } = await import('../services/cx/connectors/ebay/notifications.js')
    const query = req.query as { environment?: string; onlyHandled?: string }
    const environment = query.environment === 'sandbox' ? 'sandbox' : 'production'
    const gate = ebayNotificationSetupGate()
    if (!gate.armed) {
      const error = new EbayNotificationNotArmedError(gate.reason).message
      await auditEbayNotificationAction(req, 'ebay.notification.setup', environment, { outcome: 'refused_not_armed', topics: [], error })
      return reply.status(403).send({ ok: false, armed: false, error })
    }
    const result = await setupEbayNotifications({
      environment,
      // Default: subscribe only the topics Nexus can act on. A topic with no handler
      // would arrive, be recorded and then dead-letter (P2.1) — visible, but noise.
      skipTopicsWithoutHandlers: true,
    })
    const ok = ebayNotificationSetupSucceeded(result)
    await auditEbayNotificationAction(req, 'ebay.notification.setup', environment, {
      outcome: !result.configured ? 'not_configured' : !result.armed ? 'refused_not_armed' : ok ? 'succeeded' : 'failed',
      topics: gate.topics, destinationId: result.destinationId,
      perTopic: result.perTopic.map(topic => ({ topicId: topic.topicId, status: topic.status })), error: result.error,
    })
    if (!result.configured) {
      return reply.status(400).send({ ok: false, ...result })
    }
    // A wrong topic id is reported as its own thing, not folded into "failed". It is
    // the finding this package exists to surface.
    return reply.send({
      ok,
      ...result,
      hint: result.notOffered.length
        ? `eBay's catalogue does not contain: ${result.notOffered.join(', ')}. Correct them in services/cx/ingress/ebay-topics.ts.`
        : undefined,
    })
  })

  // ── POST /api/admin/ebay-notification-test?topicId=… ───────────────
  // S1 — eBay's own test notice for our subscription (POST /subscription/{id}/test). It
  // arrives signed at the receiver like a real notice, so it proves the whole path.
  app.post('/admin/ebay-notification-test', async (req, reply) => {
    const { sendEbayTestNotice, ebayNotificationSetupGate, EbayNotificationNotArmedError } = await import('../services/cx/connectors/ebay/notifications.js')
    const query = req.query as { environment?: string; topicId?: string }
    const environment = query.environment === 'sandbox' ? 'sandbox' : 'production'
    const topicId = typeof query.topicId === 'string' ? query.topicId : ''
    // Only a well-formed topic id is ever written to the audit row.
    const requested = /^[A-Z][A-Z0-9_]{0,63}$/.test(topicId) ? [topicId] : []
    const gate = ebayNotificationSetupGate()
    if (!gate.armed) {
      const error = new EbayNotificationNotArmedError(gate.reason).message
      await auditEbayNotificationAction(req, 'ebay.notification.test', environment, { outcome: 'refused_not_armed', topics: requested, error })
      return reply.status(403).send({ ok: false, armed: false, error })
    }
    if (!gate.topics.includes(topicId)) {
      const error = `topicId must name an armed topic: ${gate.topics.join(', ')}.`
      await auditEbayNotificationAction(req, 'ebay.notification.test', environment, { outcome: 'refused_topic_not_armed', topics: requested, error })
      return reply.status(400).send({ ok: false, error })
    }
    const result = await sendEbayTestNotice(environment, topicId)
    await auditEbayNotificationAction(req, 'ebay.notification.test', environment, {
      outcome: result.ok ? 'sent' : 'failed', topics: [topicId], subscriptionId: result.subscriptionId, error: result.error,
    })
    return reply.send(result)
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
    const {
      ebayNotificationConfig, ebayVerificationTokenError, ebayNotificationAlertEmail, ebayNotificationSetupGate,
    } = await import('../services/cx/connectors/ebay/notifications.js')
    const config = ebayNotificationConfig()
    const endpoint = config.endpoint
    /**
     * Local facts, read without eBay and returned on the error path too: the runbook's first
     * check is `configured.verificationTokenValid`, and it must not depend on eBay answering.
     * Booleans and fixed text only; never the token or the address.
     */
    const local = {
      /**
       * Whether the two variables the ownership hash is built from are set at all.
       * Without this, a null `endpoint` reads as "eBay has nothing" when it means
       * "we did not ask for anything".
       */
      configured: {
        hasEndpoint: !!config.endpoint, hasVerificationToken: !!config.verificationToken,
        verificationTokenValid: !ebayVerificationTokenError(config.verificationToken),
        hasAlertEmail: !!ebayNotificationAlertEmail(),
      },
      configurationError: ebayVerificationTokenError(config.verificationToken),
      /** Whether setup may write to eBay, and which topics the Owner armed. */
      setupGate: ebayNotificationSetupGate(),
    }
    try {
      const [topics, destinations, subscriptions] = await Promise.all([
        getEbayTopics(environment), getEbayDestinations(environment), getEbaySubscriptions(environment),
      ])
      const offered = new Set(topics.map((t) => t.topicId))
      const ours = endpoint ? destinations.find((d) => d.endpoint === endpoint) ?? null : null
      return reply.send({
        environment,
        endpoint,
        ...local,
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
      return reply.status(500).send({ ...local, error: err?.message ?? String(err) })
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

  // Durable acceptance is separate from claim-aware background processing.
  // eBay marks an endpoint down after 24 h without a 2xx. receiveEbayNotice returns as soon as
  // this delivery's storage transaction commits and runs nothing after it (a deletion notice is
  // reviewed later by the retry worker), so every error below happened BEFORE storage and a
  // non-2xx correctly asks eBay to redeliver. A stored notice always gets 200.
  app.post('/webhooks/ebay-notification', { bodyLimit: 1_048_576 }, async (req, reply) => {
    const rawBody = (req as RawBodyRequest).rawBody
    if (!rawBody) return reply.status(400).send({ error: 'Raw body unavailable.' })
    const signature = req.headers['x-ebay-signature']
    try {
      const result = await receiveEbayNotice({ rawBody, header: typeof signature === 'string' ? signature : undefined })
      if (result.kind === 'rejected') {
        const unavailable = ['app_token_unavailable', 'public_key_forbidden', 'public_key_not_found'].includes(result.reason)
        return reply.status(unavailable ? 503 : 412).send({ error: unavailable
          ? 'Notification verification is temporarily unavailable.' : 'Signature verification failed.' })
      }
      // A quarantine acknowledgement means only that the verified body is durable.
      // It does not claim erasure, lifecycle change or successful order ingestion.
      return reply.status(200).send({ received: true })
    } catch (error) {
      const reason = error instanceof EbayAdmissionError ? error.reason : 'storage_unavailable'
      logger.error('[eBay notification] durable admission failed', { reason })
      return reply.status(reason === 'invalid_body' ? 400 : 503).send({ error: 'Notification could not be stored safely. Retry delivery.' })
    }
  })
}
