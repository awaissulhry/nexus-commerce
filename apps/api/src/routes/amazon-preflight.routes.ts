/**
 * ALA Phase 8 — Pre-Flight report endpoint (capstone backend).
 *
 *   GET /api/products/:id/preflight?marketplace=<MP>&live=1
 *
 * Returns the aggregated "what's wrong + what's changing" report for a product's
 * Amazon listings: byte-length / required / conditional / mirrored issues + a
 * per-attribute diff vs live Amazon. `live=1` additionally runs Amazon's
 * VALIDATION_PREVIEW (authoritative) and mirrors the result — use it at the
 * confirm step; omit it for the always-on health panel (fast, no extra SP-API).
 *
 * Separate route file (not folded into amazon-cockpit-publish.routes.ts) to keep
 * a one-way import edge: preflight-report.service imports buildRow from the
 * cockpit route, so the cockpit route must NOT import preflight.
 */
import type { FastifyInstance } from 'fastify'
import { buildPreflightReport } from '../services/amazon/preflight-report.service.js'

export default async function amazonPreflightRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string }; Querystring: { marketplace?: string; live?: string } }>(
    '/products/:id/preflight',
    async (request, reply) => {
      const { id } = request.params
      const marketplace = request.query.marketplace ? request.query.marketplace.toUpperCase() : null
      const live = request.query.live === '1' || request.query.live === 'true'
      try {
        const report = await buildPreflightReport(id, marketplace, { live })
        return { ...report, generatedAt: new Date().toISOString() }
      } catch (err: any) {
        if (err?.message === 'Product not found') return reply.code(404).send({ error: 'Product not found' })
        request.log.error(err, 'preflight report failed')
        return reply.code(500).send({ error: err?.message ?? 'Preflight failed' })
      }
    },
  )
}
