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
 *
 * MCP full control P3: the audit reads live in services/audit/audit-search.service.ts.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { auditLogEntry, searchAuditLog, type AuditSearchQuery } from '../services/audit/audit-search.service.js'

const auditLogRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: AuditSearchQuery
  }>('/audit-log/search', async (request, reply) => {
    try {
      return reply.send({ success: true, ...(await searchAuditLog(request.query)) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[audit-log/search] failed')
      return reply.code(500).send({ success: false, error: message })
    }
  })

  // ES.4 — GET /api/events
  // General ProductEvent feed. Used by the /audit-log page "Event Log"
  // mode and the /sync-logs/events sub-page.
  fastify.get<{
    Querystring: {
      aggregateType?: string
      aggregateId?: string
      eventType?: string
      source?: string
      since?: string
      until?: string
      limit?: string
      cursor?: string
    }
  }>('/events', async (request, reply) => {
    try {
      const q = request.query
      const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)

      const where: any = {}
      if (q.aggregateType) {
        const types = q.aggregateType.split(',').map((s) => s.trim()).filter(Boolean)
        if (types.length === 1) where.aggregateType = types[0]
        else if (types.length > 1) where.aggregateType = { in: types }
      }
      if (q.aggregateId) where.aggregateId = q.aggregateId
      if (q.eventType) {
        const types = q.eventType.split(',').map((s) => s.trim()).filter(Boolean)
        if (types.length === 1) where.eventType = types[0]
        else if (types.length > 1) where.eventType = { in: types }
      }
      if (q.source) {
        const sources = q.source.split(',').map((s) => s.trim()).filter(Boolean)
        // source is stored inside metadata JSON — use Prisma JSON path filter
        if (sources.length === 1) {
          where.metadata = { path: ['source'], equals: sources[0] }
        } else {
          where.OR = sources.map((s) => ({
            metadata: { path: ['source'], equals: s },
          }))
        }
      }
      if (q.since || q.until) {
        where.createdAt = {}
        if (q.since) where.createdAt.gte = new Date(q.since)
        if (q.until) where.createdAt.lte = new Date(q.until)
      }

      const rows = await prisma.productEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      })

      const hasNext = rows.length > limit
      const events = hasNext ? rows.slice(0, limit) : rows
      const nextCursor = hasNext ? events[events.length - 1].id : null

      return reply.send({ success: true, events, nextCursor })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[events] failed')
      return reply.code(500).send({ success: false, error: message })
    }
  })

  fastify.get<{ Params: { id: string } }>(
    '/audit-log/:id',
    async (request, reply) => {
      try {
        const { id } = request.params
        const row = await auditLogEntry(id)
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
