/**
 * Shopify marketing consent, per Shopify account (services/shopify/marketing-consent.service.ts):
 *
 * - `POST /api/shopify/marketing-consent/:accountId/backfill` — a person copies the e-mail marketing consent of every
 *   Shopify BUYER of this account into Nexus (only a hash of each e-mail is kept). It reads Shopify only, a page at a
 *   time through the channel gateway, and answers counts only. A run cut short (page bound, Shopify's rate limit)
 *   answers `resumeAfter`; send it back as `{ "after": "…" }` to go on. Running it again is safe.
 *
 * RBAC: settings.integrations.manage, the people who manage channel connections (as Shopify order import).
 */
import type { FastifyInstance } from 'fastify'
import { backfillShopifyMarketingConsent } from '../services/shopify/marketing-consent.service.js'

function failure(err: unknown) {
  const known = err as { code?: unknown; statusCode?: unknown }
  const isKnown = typeof known.statusCode === 'number' && typeof known.code === 'string'
  return {
    statusCode: isKnown ? (known.statusCode as number) : 500,
    body: { ok: false, code: isKnown ? known.code : 'SHOPIFY_CONSENT_BACKFILL_FAILED', error: err instanceof Error ? err.message.slice(0, 400) : 'The Shopify consent backfill failed.' },
  }
}

export default async function shopifyMarketingConsentRoutes(app: FastifyInstance) {
  app.post<{ Params: { accountId: string }; Body: { after?: unknown } | undefined }>('/shopify/marketing-consent/:accountId/backfill', async (req, reply) => {
    const after = req.body?.after
    if (after !== undefined && after !== null && typeof after !== 'string') {
      return reply.code(400).send({ ok: false, code: 'BAD_CURSOR', error: '`after` is the resumeAfter value an earlier run answered.' })
    }
    const cursor = typeof after === 'string' ? after : null
    try {
      return reply.send({ ok: true, backfill: await backfillShopifyMarketingConsent(req.params.accountId, { after: cursor }) })
    } catch (err) {
      const { statusCode, body } = failure(err)
      return reply.code(statusCode).send(body)
    }
  })
}
