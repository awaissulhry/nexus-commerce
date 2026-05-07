/**
 * Audit log search/browse endpoints.
 *
 * The AuditLog table is written to by every mutation across the app
 * (products.routes.ts, pim.routes.ts, products-ai, products-images,
 * MasterPriceService, etc.) — append-only with userId/ip/before/after/
 * metadata fields. Pre-this surface there was no UI to browse it.
 *
 * GET /api/audit-log/search — paginated with filters
 * GET /api/audit-log/:id    — single entry detail
 */

import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'

const auditLogRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      entityType?: string
      entityId?: string
      // O.74: comma-separated set support so callers (drawer's
      // "View full audit log") can pass multiple shipment IDs for
      // a multi-package order in a single query string.
      entityIds?: string
      userId?: string
      action?: string
      search?: string
      since?: string
      until?: string
      limit?: string
      cursor?: string
    }
  }>('/audit-log/search', async (request, reply) => {
    try {
      const q = request.query
      const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)

      const where: Prisma.AuditLogWhereInput = {}
      if (q.entityType) where.entityType = q.entityType
      if (q.entityId) where.entityId = q.entityId
      else if (q.entityIds) {
        const ids = q.entityIds.split(',').map((s) => s.trim()).filter(Boolean)
        if (ids.length > 0) where.entityId = { in: ids }
      }
      if (q.userId) where.userId = q.userId
      if (q.action) where.action = q.action
      if (q.since || q.until) {
        where.createdAt = {}
        if (q.since) where.createdAt.gte = new Date(q.since)
        if (q.until) where.createdAt.lte = new Date(q.until)
      }
      if (q.search && q.search.trim().length > 0) {
        // Free-text search across entityId + entityType + action.
        // metadata is JSON; search via path expression on Postgres
        // is awkward without a typed key, so we keep the search
        // surface deliberately tight here.
        const term = q.search.trim()
        where.OR = [
          { entityId: { contains: term, mode: 'insensitive' } },
          { entityType: { contains: term, mode: 'insensitive' } },
          { action: { contains: term, mode: 'insensitive' } },
          { userId: { contains: term, mode: 'insensitive' } },
        ]
      }

      // Cursor pagination: cursor is the last seen id; fetch the
      // limit+1 to know if there's a next page.
      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          userId: true,
          ip: true,
          entityType: true,
          entityId: true,
          action: true,
          before: true,
          after: true,
          metadata: true,
          createdAt: true,
        },
      })
      const hasNext = rows.length > limit
      const items = hasNext ? rows.slice(0, limit) : rows
      const nextCursor = hasNext ? items[items.length - 1].id : null

      // Aggregate counts for filter chips (cheap when scoped to the
      // current `since` window; default 30 days back if nothing set).
      const countSince = q.since
        ? new Date(q.since)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const [byEntityType, byAction] = await Promise.all([
        prisma.auditLog.groupBy({
          by: ['entityType'],
          where: { createdAt: { gte: countSince } },
          _count: { _all: true },
          orderBy: { _count: { entityType: 'desc' } },
          take: 10,
        }),
        prisma.auditLog.groupBy({
          by: ['action'],
          where: { createdAt: { gte: countSince } },
          _count: { _all: true },
          orderBy: { _count: { action: 'desc' } },
          take: 10,
        }),
      ])

      return reply.send({
        success: true,
        items,
        nextCursor,
        facets: {
          entityType: byEntityType.map((g) => ({
            value: g.entityType,
            count: g._count._all,
          })),
          action: byAction.map((g) => ({
            value: g.action,
            count: g._count._all,
          })),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[audit-log/search] failed')
      return reply.code(500).send({ success: false, error: message })
    }
  })

  fastify.get<{ Params: { id: string } }>(
    '/audit-log/:id',
    async (request, reply) => {
      try {
        const { id } = request.params
        const row = await prisma.auditLog.findUnique({
          where: { id },
        })
        if (!row) {
          return reply.code(404).send({ error: 'Audit log entry not found' })
        }
        return reply.send({ success: true, entry: row })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        fastify.log.error({ err }, '[audit-log/:id] failed')
        return reply.code(500).send({ success: false, error: message })
      }
    },
  )
}

export default auditLogRoutes
