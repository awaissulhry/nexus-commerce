/**
 * Shopify order import, per Shopify account (services/shopify/order-import-start.service.ts):
 *
 * - `GET  /api/shopify/order-import/:accountId` — read only: whether the server switch is on and the account's start
 *   date (null when order import was never started for it).
 * - `POST /api/shopify/order-import/:accountId/start` — records the start date the first time (kept on every later
 *   call) and registers the order webhooks. Orders Shopify created before the start date are never imported.
 *
 * Both need NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1 to do anything beyond reading (the POST is refused with 409 while it is
 * off). RBAC: settings.integrations.manage, the people who manage channel connections.
 */
import type { FastifyInstance } from 'fastify'
import { shopifyOrderImportStatus, startShopifyOrderImport } from '../services/shopify/order-import-start.service.js'

function failure(err: unknown, fallback: string) {
  const known = err as { code?: unknown; statusCode?: unknown }
  const isKnown = typeof known.statusCode === 'number' && typeof known.code === 'string'
  return {
    statusCode: isKnown ? (known.statusCode as number) : 500,
    body: { ok: false, code: isKnown ? known.code : fallback, error: err instanceof Error ? err.message.slice(0, 400) : 'Shopify order import failed.' },
  }
}

export default async function shopifyOrderImportRoutes(app: FastifyInstance) {
  app.get<{ Params: { accountId: string } }>('/shopify/order-import/:accountId', async (req, reply) => {
    try {
      return reply.send({ ok: true, status: await shopifyOrderImportStatus(req.params.accountId) })
    } catch (err) {
      const { statusCode, body } = failure(err, 'SHOPIFY_ORDER_IMPORT_STATUS_FAILED')
      return reply.code(statusCode).send(body)
    }
  })

  app.post<{ Params: { accountId: string } }>('/shopify/order-import/:accountId/start', async (req, reply) => {
    try {
      return reply.send({ ok: true, start: await startShopifyOrderImport(req.params.accountId, req.authUser?.id ?? null) })
    } catch (err) {
      const { statusCode, body } = failure(err, 'SHOPIFY_ORDER_IMPORT_START_FAILED')
      return reply.code(statusCode).send(body)
    }
  })
}
