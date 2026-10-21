/**
 * Meta ads step 30 (2026-10-21) — Meta's webhook endpoint: `/webhooks/meta/<app id>` (public; Meta signs every POST).
 *
 *   GET   Meta's verification (WH-001): `hub.mode=subscribe`, `hub.verify_token` equal to META_WEBHOOK_VERIFY_TOKEN
 *         (constant time) and an app a connected business uses → 200 with exactly `hub.challenge` (text/plain);
 *         otherwise 403, so a subscription to an app Nexus does not know fails at once. Its request log is off: the
 *         query string holds the verify token.
 *   POST  a notification (WH-002, WH-004): the raw bytes are kept unparsed until a connected business's own app secret
 *         matched X-Hub-Signature-256 over them; then services/marketing/meta-ads/webhook-receiver.ts routes, records
 *         and handles each change. 200 when every change is recorded or ignored, 503 when the ledger could not take one
 *         (Meta resends; recorded changes are duplicates), 401 when no secret signed it (recorded as rejected).
 *
 * The callback URL Meta is given is this path with the business's Meta app id (set-meta-webhooks, the change tool, or
 * the App Dashboard for Instagram and Messenger fields). No Prisma here: the receiver service does the work.
 */
import type { FastifyInstance } from 'fastify'
import { logger } from '../utils/logger.js'
import { registerRawJsonParser, type RawBodyRequest } from '../utils/webhook.js'
import { metaChallengeOf, metaVerifyTokenOk } from '../services/cx/connectors/meta/webhook-signature.js'
import { META_APP_ID, metaAppConnected, metaSigningBusinesses, receiveMetaWebhook, recordMetaRejection } from '../services/marketing/meta-ads/webhook-receiver.js'
import { parseMetaJson } from '../services/marketing/meta-ads/webhook-topics.js'

/** Meta batches up to 1000 updates; a bigger body than this is refused before anything else. */
export const META_WEBHOOK_BODY_LIMIT = 4 * 1024 * 1024

export default async function metaWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Meta signs the exact bytes it sent: this plugin's routes get the Buffer only, never a parsed body.
  registerRawJsonParser(app, { rawBodyOnly: () => true })

  app.get('/webhooks/meta/:appId', { logLevel: 'warn' }, async (request, reply) => {
    const { appId } = request.params as { appId: string }
    const query = request.query as Record<string, unknown>
    const challenge = metaChallengeOf(query['hub.challenge'])
    const ok = query['hub.mode'] === 'subscribe' && !!challenge
      && metaVerifyTokenOk(query['hub.verify_token'], process.env.META_WEBHOOK_VERIFY_TOKEN)
      && META_APP_ID.test(appId) && await metaAppConnected(appId)
    if (!ok) {
      logger.warn('[meta-webhooks] verification refused', { appIdValid: META_APP_ID.test(appId), tokenSet: !!process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() })
      return reply.status(403).send({ error: 'Verification refused.' })
    }
    return reply.status(200).header('content-type', 'text/plain; charset=utf-8').header('x-content-type-options', 'nosniff').send(challenge)
  })

  app.post('/webhooks/meta/:appId', { bodyLimit: META_WEBHOOK_BODY_LIMIT }, async (request, reply) => {
    const startedAt = Date.now()
    const { appId } = request.params as { appId: string }
    const raw = (request as RawBodyRequest).rawBody ?? null
    if (!META_APP_ID.test(appId)) return reply.status(404).send({ error: 'Not found.' })
    if (!raw || raw.length === 0) return reply.status(400).send({ error: 'Empty body.' })

    // 1 — trust, on the raw bytes, before any parse.
    const signers = await metaSigningBusinesses(appId, raw, request.headers['x-hub-signature-256'])
    if (signers.businesses.length === 0) {
      const reason = signers.appKnown
        ? 'X-Hub-Signature-256 does not match the app secret of any business connected with this Meta app.'
        : 'No business connected in Nexus uses this Meta app, so no secret can check the signature.'
      await recordMetaRejection(raw, request.headers, reason)
      logger.warn('[meta-webhooks] signature rejected', { appKnown: signers.appKnown })
      return reply.status(401).send({ error: 'Signature verification failed.' })
    }

    // 2 — verified: only now is the body read.
    let body: unknown
    try {
      body = parseMetaJson(raw)
    } catch {
      logger.warn('[meta-webhooks] a signed delivery is not JSON')
      return reply.status(400).send({ error: 'The body is not JSON.' })
    }
    const outcome = await receiveMetaWebhook({ appId, businesses: signers.businesses, body, startedAt })
    if (!outcome) return reply.status(200).send({ success: true, ignored: true })
    if (outcome.notRecorded > 0) {
      logger.error('[meta-webhooks] changes not recorded; Meta is asked to send them again', { notRecorded: outcome.notRecorded, changes: outcome.changes })
      return reply.status(503).send({ error: 'Not recorded; send again.' })
    }
    return reply.status(200).send({ success: true })
  })
}
