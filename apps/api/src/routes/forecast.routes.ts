/**
 * H.12 — stock-out projection endpoints.
 *
 *   GET /api/products/:id/forecast
 *     → StockoutProjection for one product.
 *
 *   GET /api/forecast/stockout-risk?leadTime=30&limit=200&horizon=90
 *     → ranked list of products whose projected stockout falls within
 *       the lead-time window. Sorted by daysOfCover ascending so the
 *       most urgent items render first.
 *
 *     ?status=critical|warn|all (default 'critical,warn')
 *     ?channels=AMAZON,EBAY (filters underlying forecast set; not
 *                            implemented v1 — placeholder for future)
 *
 * 30s cache header so the front page list stays cheap to poll
 * during a triage workflow ("refresh; what changed?").
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  projectStockout,
  projectStockoutBatch,
  type Urgency,
} from '../services/forecast/stockout-projection.service.js'

interface RiskQuery {
  leadTime?: string
  horizon?: string
  limit?: string
  status?: string
}

const forecastRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/forecast',
    async (request, reply) => {
      const { id } = request.params
      const projection = await projectStockout(prisma, id)
      if (!projection) return reply.code(404).send({ error: 'Product not found' })
      reply.header('Cache-Control', 'private, max-age=30')
      return projection
    },
  )

  fastify.get<{ Querystring: RiskQuery }>(
    '/forecast/stockout-risk',
    async (request, reply) => {
      const q = request.query ?? {}
      const leadTimeDays = Math.max(
        1,
        Math.min(parseInt(q.leadTime ?? '30', 10) || 30, 365),
      )
      const horizonDays = Math.max(
        7,
        Math.min(parseInt(q.horizon ?? '90', 10) || 90, 365),
      )
      const limit = Math.max(
        1,
        Math.min(parseInt(q.limit ?? '200', 10) || 200, 1000),
      )
      const requestedStatuses = (q.status ?? 'critical,warn')
        .split(',')
        .map((s) => s.trim().toLowerCase())
      const wantAll = requestedStatuses.includes('all')
      const statusFilter = new Set<Urgency>([
        ...(wantAll || requestedStatuses.includes('critical')
          ? (['critical'] as Urgency[])
          : []),
        ...(wantAll || requestedStatuses.includes('warn')
          ? (['warn'] as Urgency[])
          : []),
        ...(wantAll || requestedStatuses.includes('ok')
          ? (['ok'] as Urgency[])
          : []),
        ...(wantAll || requestedStatuses.includes('unknown')
          ? (['unknown'] as Urgency[])
          : []),
      ])

      // Run projection across every active buyable product. With ~3,200
      // SKUs at Xavia today this is one DB read for products + one for
      // all in-horizon forecasts; cheap enough for a 30s-cached page.
      const products = await prisma.product.findMany({
        where: { isParent: false, status: { not: 'INACTIVE' } },
        select: { id: true },
        take: 5000,
      })
      const productIds = products.map((p) => p.id)
      const projections = await projectStockoutBatch(prisma, productIds, {
        leadTimeDays,
        horizonDays,
      })
      const filtered = projections
        .filter((p) => statusFilter.has(p.urgency))
        .sort((a, b) => {
          // Critical first, then by ascending daysOfCover (sooner first),
          // null daysOfCover sinks to the bottom of its bucket.
          const order: Record<Urgency, number> = {
            critical: 0,
            warn: 1,
            unknown: 2,
            ok: 3,
          }
          if (order[a.urgency] !== order[b.urgency]) {
            return order[a.urgency] - order[b.urgency]
          }
          if (a.daysOfCover == null && b.daysOfCover == null) return 0
          if (a.daysOfCover == null) return 1
          if (b.daysOfCover == null) return -1
          return a.daysOfCover - b.daysOfCover
        })
        .slice(0, limit)

      // Hydrate top-of-list rows with name/image/price so the UI page
      // can render without a per-row product fetch. Done after slicing
      // so we only pay for the visible window.
      const ids = filtered.map((p) => p.productId)
      const hydrated = await prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          basePrice: true,
          status: true,
          images: {
            where: { type: 'MAIN' },
            take: 1,
            select: { url: true },
          },
        },
      })
      const byId = new Map(hydrated.map((p) => [p.id, p]))
      const rows = filtered.map((p) => {
        const h = byId.get(p.productId)
        return {
          ...p,
          name: h?.name ?? null,
          basePrice: h?.basePrice != null ? Number(h.basePrice) : null,
          status: h?.status ?? null,
          imageUrl: h?.images?.[0]?.url ?? null,
        }
      })

      reply.header('Cache-Control', 'private, max-age=30')
      return {
        params: { leadTimeDays, horizonDays, limit },
        counts: {
          critical: projections.filter((p) => p.urgency === 'critical').length,
          warn: projections.filter((p) => p.urgency === 'warn').length,
          ok: projections.filter((p) => p.urgency === 'ok').length,
          unknown: projections.filter((p) => p.urgency === 'unknown').length,
          total: projections.length,
        },
        rows,
      }
    },
  )
}

export default forecastRoutes
