/**
 * `GET /api/shopify/shadow-report/:accountId?days=60` — the Shopify orders shadow report.
 *
 * Read-only: it reads the account's recent orders from Shopify (channel gateway, `kind: 'read'`) and
 * Nexus product SKUs, and answers with counts. Nothing is written to orders, stock, listings or
 * Shopify, and no buyer data is read or returned. Off unless NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT=1;
 * RBAC: settings.integrations.manage (the people who manage channel connections).
 * The logic is in services/shopify/order-shadow-report.service.ts.
 */
import type { FastifyInstance } from 'fastify'
import { shopifyShadowReport } from '../services/shopify/order-shadow-report.service.js'

export default async function shopifyShadowReportRoutes(app: FastifyInstance) {
  app.get<{ Params: { accountId: string }; Querystring: { days?: string } }>('/shopify/shadow-report/:accountId', async (req, reply) => {
    const days = req.query.days === undefined || req.query.days === '' ? undefined : Number(req.query.days)
    try {
      return reply.send({ ok: true, report: await shopifyShadowReport(req.params.accountId, { days }) })
    } catch (err) {
      const failure = err as { code?: unknown; statusCode?: unknown }
      const known = typeof failure.statusCode === 'number' && typeof failure.code === 'string'
      return reply.code(known ? (failure.statusCode as number) : 500).send({
        ok: false,
        code: known ? failure.code : 'SHOPIFY_SHADOW_REPORT_FAILED',
        error: err instanceof Error ? err.message.slice(0, 400) : 'The Shopify shadow report failed. Nothing was written.',
      })
    }
  })
}
