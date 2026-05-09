/**
 * L.3.4 — /api/sync-logs/* endpoints powering the unified hub.
 *
 * One endpoint per hub section so the client can fan out parallel
 * fetches that each map to one panel. Cache headers keep polling
 * sub-cent under the 30s hub poll cadence.
 *
 *   GET /api/sync-logs/api-calls
 *     Outbound API call rollup over a time window:
 *       - stats: totals, success rate, latency percentiles
 *       - byChannel, byOperation, errorsByType, statusCodes
 *       - recent: latest N rows
 *
 *   GET /api/sync-logs/api-calls/recent
 *     Paginated list of recent API calls with filters (channel,
 *     operation, success, errorType, since, until).
 *
 * Query params (all optional):
 *   ?since=ISO       (default: now - 24h)
 *   ?until=ISO       (default: now)
 *   ?channel=AMAZON  (filter)
 *   ?operation=getOrders  (filter)
 *   ?success=true|false   (filter)
 *   ?limit=50, ?cursor=<id>  (recent endpoint pagination)
 */

import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

interface CallsQuery {
  since?: string
  until?: string
  channel?: string
  operation?: string
  success?: string
  errorType?: string
  limit?: string
  cursor?: string
}

function parseWindow(q: CallsQuery): { since: Date; until: Date } {
  const until = q.until ? new Date(q.until) : new Date()
  const since = q.since
    ? new Date(q.since)
    : new Date(until.getTime() - DEFAULT_WINDOW_MS)
  return { since, until }
}

function buildWhere(
  q: CallsQuery,
  range: { since: Date; until: Date },
): Prisma.OutboundApiCallLogWhereInput {
  const where: Prisma.OutboundApiCallLogWhereInput = {
    createdAt: { gte: range.since, lte: range.until },
  }
  if (q.channel) where.channel = q.channel
  if (q.operation) where.operation = q.operation
  if (q.success === 'true') where.success = true
  else if (q.success === 'false') where.success = false
  if (q.errorType) where.errorType = q.errorType
  return where
}

const syncLogsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Aggregate rollup. One round-trip; the hub renders every API-call
   * panel from this single response.
   */
  fastify.get<{ Querystring: CallsQuery }>(
    '/sync-logs/api-calls',
    async (request, reply) => {
      try {
        reply.header('Cache-Control', 'private, max-age=15')
        const range = parseWindow(request.query)
        const where = buildWhere(request.query, range)

        // Cap latency percentiles to a sane window — full table scans
        // get expensive once OutboundApiCallLog is at scale. The
        // index on (createdAt) makes the filtered scan fast.
        const [
          total,
          successCount,
          byChannel,
          byOperation,
          errorsByType,
          statusCodes,
          recent,
          percentiles,
        ] = await Promise.all([
          prisma.outboundApiCallLog.count({ where }),
          prisma.outboundApiCallLog.count({
            where: { ...where, success: true },
          }),
          prisma.outboundApiCallLog.groupBy({
            by: ['channel'],
            where,
            _count: { _all: true },
          }),
          prisma.outboundApiCallLog.groupBy({
            by: ['operation'],
            where,
            _count: { _all: true },
            orderBy: { _count: { operation: 'desc' } },
            take: 20,
          }),
          prisma.outboundApiCallLog.groupBy({
            by: ['errorType'],
            where: { ...where, success: false },
            _count: { _all: true },
          }),
          prisma.outboundApiCallLog.groupBy({
            by: ['statusCode'],
            where,
            _count: { _all: true },
            orderBy: { _count: { statusCode: 'desc' } },
            take: 10,
          }),
          prisma.outboundApiCallLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 25,
            select: {
              id: true,
              channel: true,
              marketplace: true,
              operation: true,
              statusCode: true,
              success: true,
              latencyMs: true,
              errorType: true,
              errorMessage: true,
              createdAt: true,
              triggeredBy: true,
            },
          }),
          // Postgres percentile_disc — Prisma doesn't surface percentile
          // aggregates so use $queryRawUnsafe with bound params via
          // string concatenation we already validated (no user input
          // hits the SQL: only the bound timestamps + literal channel).
          prisma.$queryRaw<
            Array<{ p50: number | null; p95: number | null; p99: number | null }>
          >`
            SELECT
              percentile_disc(0.50) WITHIN GROUP (ORDER BY "latencyMs")::int AS p50,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY "latencyMs")::int AS p95,
              percentile_disc(0.99) WITHIN GROUP (ORDER BY "latencyMs")::int AS p99
            FROM "OutboundApiCallLog"
            WHERE "createdAt" >= ${range.since}
              AND "createdAt" <= ${range.until}
              ${request.query.channel ? Prisma.sql`AND "channel" = ${request.query.channel}` : Prisma.empty}
              ${request.query.operation ? Prisma.sql`AND "operation" = ${request.query.operation}` : Prisma.empty}
          `,
        ])

        const errorRate = total === 0 ? 0 : (total - successCount) / total
        const p = percentiles[0] ?? { p50: null, p95: null, p99: null }

        return reply.send({
          generatedAt: new Date().toISOString(),
          window: { since: range.since, until: range.until },
          stats: {
            total,
            successful: successCount,
            failed: total - successCount,
            errorRate,
            latencyP50Ms: p.p50,
            latencyP95Ms: p.p95,
            latencyP99Ms: p.p99,
          },
          byChannel: byChannel.map((g) => ({
            channel: g.channel,
            count: g._count._all,
          })),
          byOperation: byOperation.map((g) => ({
            operation: g.operation,
            count: g._count._all,
          })),
          errorsByType: errorsByType.map((g) => ({
            errorType: g.errorType ?? 'UNKNOWN',
            count: g._count._all,
          })),
          statusCodes: statusCodes.map((g) => ({
            statusCode: g.statusCode,
            count: g._count._all,
          })),
          recent,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        fastify.log.error({ err }, '[sync-logs/api-calls] failed')
        return reply.code(500).send({ error: message })
      }
    },
  )

  /**
   * Paginated recent calls list with filters. Used by the hub's
   * dedicated /sync-logs/api-calls sub-route (Phase L2).
   */
  fastify.get<{ Querystring: CallsQuery }>(
    '/sync-logs/api-calls/recent',
    async (request, reply) => {
      try {
        reply.header('Cache-Control', 'private, max-age=10')
        const range = parseWindow(request.query)
        const where = buildWhere(request.query, range)
        const limit = Math.min(
          Math.max(Number(request.query.limit ?? 50), 1),
          200,
        )

        const rows = await prisma.outboundApiCallLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit + 1,
          ...(request.query.cursor
            ? { cursor: { id: request.query.cursor }, skip: 1 }
            : {}),
        })
        const hasNext = rows.length > limit
        const items = hasNext ? rows.slice(0, limit) : rows
        const nextCursor = hasNext ? items[items.length - 1].id : null

        return reply.send({
          items,
          nextCursor,
          window: { since: range.since, until: range.until },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        fastify.log.error({ err }, '[sync-logs/api-calls/recent] failed')
        return reply.code(500).send({ error: message })
      }
    },
  )
}

export default syncLogsRoutes
