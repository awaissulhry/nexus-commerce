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
import {
  subscribeSyncLogEvents,
  type SyncLogEvent,
} from '../services/sync-logs-events.service.js'

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
   * L.13.0 — CSV / JSON export for filtered API calls.
   *
   * GET /api/sync-logs/api-calls/export?format=csv|json
   *   Same filter set as /recent (channel, operation, success,
   *   errorType, since, until). Hard cap of 50k rows per export
   *   to bound memory; if the operator needs more they should
   *   tighten the filter or split by date.
   *
   * CSV format mirrors the Stripe payment export style: one column
   * per scalar field, stable column order so spreadsheets stay
   * importable across versions. Payload columns are stringified.
   */
  fastify.get<{
    Querystring: CallsQuery & { format?: string }
  }>('/sync-logs/api-calls/export', async (request, reply) => {
    try {
      const q = request.query
      const format = (q.format ?? 'csv').toLowerCase()
      if (format !== 'csv' && format !== 'json') {
        return reply.code(400).send({
          error: 'format must be csv or json',
        })
      }
      const range = parseWindow(q)
      const where = buildWhere(q, range)

      const rows = await prisma.outboundApiCallLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50_000,
      })

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `nexus-api-calls-${stamp}.${format}`

      if (format === 'json') {
        reply.header('Content-Type', 'application/json')
        reply.header(
          'Content-Disposition',
          `attachment; filename="${filename}"`,
        )
        return reply.send({
          generatedAt: new Date().toISOString(),
          window: range,
          count: rows.length,
          rows,
        })
      }

      // CSV: stable column order. Payload columns are JSON-stringified
      // (CSV-escaped) so spreadsheet imports get one cell per row.
      const columns = [
        'createdAt',
        'channel',
        'marketplace',
        'operation',
        'endpoint',
        'method',
        'statusCode',
        'success',
        'latencyMs',
        'errorType',
        'errorCode',
        'errorMessage',
        'requestId',
        'triggeredBy',
        'productId',
        'listingId',
        'orderId',
      ] as const

      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return ''
        const s =
          typeof v === 'string'
            ? v
            : v instanceof Date
              ? v.toISOString()
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v)
        if (/[",\n\r]/.test(s)) {
          return `"${s.replace(/"/g, '""')}"`
        }
        return s
      }

      const lines: string[] = []
      lines.push(columns.join(','))
      for (const r of rows) {
        const row = r as unknown as Record<string, unknown>
        lines.push(columns.map((c) => escape(row[c])).join(','))
      }
      const body = lines.join('\n') + '\n'

      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      )
      return reply.send(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[sync-logs/api-calls/export] failed')
      return reply.code(500).send({ error: message })
    }
  })

  /**
   * L.11.0 — bucketed time-series for the API calls chart.
   *
   * GET /api/sync-logs/api-calls/timeseries
   *   ?since=ISO         (default: now - 24h)
   *   ?until=ISO         (default: now)
   *   ?channel=AMAZON    (optional)
   *   ?operation=getX    (optional)
   *
   * Bucket size is chosen from the window:
   *   < 3h   → 5-minute buckets   (≤ 36 points)
   *   < 48h  → 1-hour buckets     (≤ 48 points)
   *   ≥ 48h  → 1-day buckets      (≤ 60 points)
   *
   * Postgres date_bin (PG14+) anchors buckets at clean boundaries
   * so points line up across reloads. percentile_disc is exact;
   * Prisma's groupBy doesn't surface percentile aggregates so we
   * reach for $queryRaw.
   */
  fastify.get<{
    Querystring: {
      since?: string
      until?: string
      channel?: string
      operation?: string
    }
  }>('/sync-logs/api-calls/timeseries', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const q = request.query
      const until = q.until ? new Date(q.until) : new Date()
      const since = q.since
        ? new Date(q.since)
        : new Date(until.getTime() - 24 * 60 * 60 * 1000)

      const windowMs = until.getTime() - since.getTime()
      const bucket =
        windowMs < 3 * 60 * 60 * 1000
          ? '5 minutes'
          : windowMs < 48 * 60 * 60 * 1000
            ? '1 hour'
            : '1 day'

      // date_bin requires an anchor; we use the unix epoch so buckets
      // are deterministic across calls. The interval string is
      // server-controlled (not user input) so Prisma.sql interpolates
      // it cleanly.
      const rows = await prisma.$queryRaw<
        Array<{
          bucket: Date
          total: bigint
          failed: bigint
          p50: number | null
          p95: number | null
          p99: number | null
        }>
      >`
        SELECT
          date_bin(${bucket}::interval, "createdAt", TIMESTAMP '1970-01-01') AS bucket,
          count(*) AS total,
          count(*) FILTER (WHERE NOT success) AS failed,
          percentile_disc(0.50) WITHIN GROUP (ORDER BY "latencyMs")::int AS p50,
          percentile_disc(0.95) WITHIN GROUP (ORDER BY "latencyMs")::int AS p95,
          percentile_disc(0.99) WITHIN GROUP (ORDER BY "latencyMs")::int AS p99
        FROM "OutboundApiCallLog"
        WHERE "createdAt" >= ${since}
          AND "createdAt" < ${until}
          ${q.channel ? Prisma.sql`AND "channel" = ${q.channel}` : Prisma.empty}
          ${q.operation ? Prisma.sql`AND "operation" = ${q.operation}` : Prisma.empty}
        GROUP BY bucket
        ORDER BY bucket
      `

      return reply.send({
        bucket,
        window: { since, until },
        points: rows.map((r) => ({
          bucket: r.bucket.toISOString(),
          total: Number(r.total),
          failed: Number(r.failed),
          errorRate: Number(r.total) === 0 ? 0 : Number(r.failed) / Number(r.total),
          p50: r.p50,
          p95: r.p95,
          p99: r.p99,
        })),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[sync-logs/api-calls/timeseries] failed')
      return reply.code(500).send({ error: message })
    }
  })

  /**
   * L.7.0 — SSE event stream for the live tail.
   *
   * Long-lived text/event-stream. Each api-call.recorded event from
   * the in-process bus emits one `data: <json>` frame. A 25-second
   * heartbeat ping defeats reverse-proxy idle timeouts; client
   * EventSource auto-reconnects on transient drops.
   *
   * GET /api/sync-logs/events
   */
  fastify.get('/sync-logs/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (event: SyncLogEvent) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {
        // Client closed mid-write. Cleanup happens via the close handler.
      }
    }

    // Initial hello so the client knows the stream is open.
    send({ type: 'ping', ts: Date.now() })

    const unsubscribe = subscribeSyncLogEvents(send)
    const heartbeat = setInterval(() => {
      send({ type: 'ping', ts: Date.now() })
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  /**
   * L.8.1 — Sentry-tier error groups list.
   *
   * GET /api/sync-logs/error-groups
   *
   * Query:
   *   ?status=ACTIVE|RESOLVED|MUTED|IGNORED   (default: ACTIVE)
   *   ?channel=AMAZON                         (optional)
   *   ?since=ISO                              (default: last 7d)
   *   ?limit=50&cursor=<id>                   (cursor pagination)
   *
   * The default status=ACTIVE filter is what the hub's red panel
   * shows — once an operator marks a group RESOLVED it disappears
   * unless it re-fires (regression detection in
   * recordErrorOccurrence flips it back).
   */
  fastify.get<{
    Querystring: {
      status?: string
      channel?: string
      since?: string
      limit?: string
      cursor?: string
    }
  }>('/sync-logs/error-groups', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=15')
      const q = request.query
      const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)
      const status = q.status ?? 'ACTIVE'
      const since = q.since
        ? new Date(q.since)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

      const where: Prisma.SyncLogErrorGroupWhereInput = {
        lastSeen: { gte: since },
      }
      if (status !== 'ALL') where.resolutionStatus = status
      if (q.channel) where.channel = q.channel

      const [rows, totals] = await Promise.all([
        prisma.syncLogErrorGroup.findMany({
          where,
          orderBy: { lastSeen: 'desc' },
          take: limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        }),
        // Counts per resolution status for the filter chip badges.
        prisma.syncLogErrorGroup.groupBy({
          by: ['resolutionStatus'],
          where: { lastSeen: { gte: since } },
          _count: { _all: true },
        }),
      ])
      const hasNext = rows.length > limit
      const items = hasNext ? rows.slice(0, limit) : rows
      const nextCursor = hasNext ? items[items.length - 1].id : null

      return reply.send({
        items,
        nextCursor,
        totals: totals.map((t) => ({
          status: t.resolutionStatus,
          count: t._count._all,
        })),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[sync-logs/error-groups] failed')
      return reply.code(500).send({ error: message })
    }
  })

  /**
   * Resolution workflow.
   *
   * POST /api/sync-logs/error-groups/:id/resolve
   *   Body: { status: 'RESOLVED' | 'MUTED' | 'IGNORED' | 'ACTIVE',
   *           notes?: string, resolvedBy?: string }
   *
   * Operator-initiated. The server doesn't track session/user yet
   * (auth is env-managed) so resolvedBy is taken from the body to
   * preserve the audit trail when a real user identity exists.
   */
  fastify.post<{
    Params: { id: string }
    Body: {
      status: 'RESOLVED' | 'MUTED' | 'IGNORED' | 'ACTIVE'
      notes?: string
      resolvedBy?: string
    }
  }>('/sync-logs/error-groups/:id/resolve', async (request, reply) => {
    try {
      const { id } = request.params
      const { status, notes, resolvedBy } = request.body
      const validStatuses = ['ACTIVE', 'RESOLVED', 'MUTED', 'IGNORED']
      if (!validStatuses.includes(status)) {
        return reply.code(400).send({
          error: `status must be one of ${validStatuses.join(', ')}`,
        })
      }
      const updated = await prisma.syncLogErrorGroup.update({
        where: { id },
        data: {
          resolutionStatus: status,
          resolvedAt: status === 'RESOLVED' ? new Date() : null,
          resolvedBy: status === 'RESOLVED' ? resolvedBy ?? null : null,
          notes: notes ?? undefined,
        },
      })
      return reply.send(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[sync-logs/error-groups/:id/resolve] failed')
      return reply.code(500).send({ error: message })
    }
  })

  /**
   * L.9.0 — Webhook event browser.
   *
   * GET /api/sync-logs/webhooks
   *
   * Query:
   *   ?channel=SHOPIFY|WOOCOMMERCE|ETSY|...
   *   ?processed=true|false        (default: undefined, return both)
   *   ?eventType=product/update    (optional)
   *   ?since=ISO                   (default: last 24h)
   *   ?limit=50&cursor=<id>
   *
   * Returns slim list rows + per-(channel, processed) totals for the
   * filter chip badges. Heavier `payload` field is excluded from the
   * list response — fetch /webhooks/:id for the full row.
   */
  fastify.get<{
    Querystring: {
      channel?: string
      processed?: string
      eventType?: string
      since?: string
      limit?: string
      cursor?: string
    }
  }>('/sync-logs/webhooks', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=15')
      const q = request.query
      const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)
      const since = q.since
        ? new Date(q.since)
        : new Date(Date.now() - 24 * 60 * 60 * 1000)

      const where: Prisma.WebhookEventWhereInput = {
        createdAt: { gte: since },
      }
      if (q.channel) where.channel = q.channel
      if (q.eventType) where.eventType = q.eventType
      if (q.processed === 'true') where.isProcessed = true
      else if (q.processed === 'false') where.isProcessed = false

      const [rows, byChannel, byProcessed] = await Promise.all([
        prisma.webhookEvent.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            channel: true,
            eventType: true,
            externalId: true,
            isProcessed: true,
            processedAt: true,
            error: true,
            createdAt: true,
            updatedAt: true,
            // Skip the heavy payload + signature fields on the list.
          },
        }),
        prisma.webhookEvent.groupBy({
          by: ['channel'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.webhookEvent.groupBy({
          by: ['isProcessed'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
      ])
      const hasNext = rows.length > limit
      const items = hasNext ? rows.slice(0, limit) : rows
      const nextCursor = hasNext ? items[items.length - 1].id : null

      return reply.send({
        items,
        nextCursor,
        totals: {
          byChannel: byChannel.map((g) => ({
            channel: g.channel,
            count: g._count._all,
          })),
          processed:
            byProcessed.find((g) => g.isProcessed === true)?._count._all ?? 0,
          unprocessed:
            byProcessed.find((g) => g.isProcessed === false)?._count._all ?? 0,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[sync-logs/webhooks] failed')
      return reply.code(500).send({ error: message })
    }
  })

  /**
   * Single webhook detail. Returns the full row INCLUDING payload +
   * signature so the operator can inspect what came in. Heavy by
   * design — only fetched on click.
   *
   * GET /api/sync-logs/webhooks/:id
   */
  fastify.get<{ Params: { id: string } }>(
    '/sync-logs/webhooks/:id',
    async (request, reply) => {
      try {
        const row = await prisma.webhookEvent.findUnique({
          where: { id: request.params.id },
        })
        if (!row) {
          return reply.code(404).send({ error: 'Webhook event not found' })
        }
        return reply.send(row)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        fastify.log.error({ err }, '[sync-logs/webhooks/:id] failed')
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
