/**
 * Flat-File Pull History — Phase 4
 *
 * Read-only access to FlatFilePullRecord, the audit table written by
 * the in-editor "Pull from Amazon" / "Pull from eBay" apply step.
 * Channel-agnostic (channel comes from query string) so the front-end
 * can show a unified pull-history drawer with a single endpoint.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'

export default async function flatFilePullHistoryRoutes(fastify: FastifyInstance) {
  // ── GET /api/flat-file/pull-history ────────────────────────────────
  // Most-recent-first list of applied pulls.
  //
  // Query params:
  //   channel       AMAZON | EBAY (required)
  //   marketplace   IT | DE | FR | ES | UK (optional — narrows further)
  //   productType   optional — Amazon only ('EBAY_ANY' marker on eBay
  //                 rows means the filter doesn't apply there)
  //   limit         default 25, max 200
  fastify.get<{
    Querystring: {
      channel?: string
      marketplace?: string
      productType?: string
      limit?: string
    }
  }>('/flat-file/pull-history', async (request, reply) => {
    const channel = (request.query.channel ?? '').toUpperCase()
    if (channel !== 'AMAZON' && channel !== 'EBAY') {
      return reply.code(400).send({ error: 'channel must be AMAZON or EBAY' })
    }

    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '25', 10) || 25, 1), 200)
    const where: Record<string, any> = { channel }
    if (request.query.marketplace) where.marketplace = request.query.marketplace.toUpperCase()
    if (request.query.productType && channel === 'AMAZON') {
      where.productType = request.query.productType.toUpperCase()
    }

    const records = await prisma.flatFilePullRecord.findMany({
      where,
      orderBy: { appliedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        channel: true,
        marketplace: true,
        productType: true,
        jobId: true,
        skusRequested: true,
        skusReturned: true,
        columnsApplied: true,
        rowsApplied: true,
        fieldsApplied: true,
        appliedAt: true,
        pulledAt: true,
        operatorNote: true,
      },
    })

    return reply.send({ records })
  })
}
