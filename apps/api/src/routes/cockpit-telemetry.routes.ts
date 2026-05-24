/**
 * AC.14 — Cockpit telemetry endpoints.
 *
 *   POST /api/cockpit/events
 *     Body: { type, productId?, marketplace?, durationMs?, payload? }
 *     Persists to AuditLog with metadata.source='cockpit-telemetry'.
 *     Rate-limited to keep a stuck retry loop from filling the table.
 *
 *   GET /api/cockpit/events/stats?days=30
 *     Rolls up: mount count + cockpit/classic toggle ratio,
 *     market-switch P50/P95 latency, publish counts + median health
 *     score at submit, suppression resolutions. Last `days` window
 *     (max 90). Cheap groupBy queries on AuditLog's (entityType,
 *     action, createdAt) index.
 *
 * No schema migration — AuditLog is the existing append-only log
 * model the codebase already writes to from products-ai.routes and
 * elsewhere.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const VALID_TYPES = new Set([
  'cockpit_mounted',
  'classic_toggled',
  'cockpit_toggled',
  'market_switched',
  'autofill_applied',
  'publish_submitted',
  'publish_failed',
  'publish_terminal',
  'suppression_resolved',
])

interface PostBody {
  type?: string
  productId?: string | null
  marketplace?: string | null
  durationMs?: number | null
  payload?: Record<string, unknown>
}

const cockpitTelemetryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: PostBody }>(
    '/cockpit/events',
    {
      // Tight rate limit: a stuck retry loop shouldn't pin AuditLog
      // writes. 120/min is generous for normal operation (one event
      // every ~500 ms per session is already chatty).
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.type || !VALID_TYPES.has(body.type)) {
        return reply.code(400).send({
          error: `type must be one of ${Array.from(VALID_TYPES).join(', ')}`,
        })
      }
      const durationMs =
        typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
          ? Math.max(0, Math.min(body.durationMs, 24 * 60 * 60 * 1000))
          : null
      const metadata: Record<string, unknown> = {
        source: 'cockpit-telemetry',
        ...(body.payload && typeof body.payload === 'object'
          ? body.payload
          : {}),
      }
      if (body.marketplace) metadata.marketplace = body.marketplace
      if (durationMs != null) metadata.durationMs = durationMs

      try {
        await prisma.auditLog.create({
          data: {
            entityType: 'AmazonCockpit',
            entityId: body.productId ?? 'global',
            action: body.type,
            metadata: metadata as any,
          },
        })
        return { ok: true }
      } catch (error: any) {
        // Telemetry write failure mustn't break the operator's
        // workflow — log and swallow.
        request.log.warn({ err: error }, '[cockpit/events POST] failed')
        return { ok: false }
      }
    },
  )

  fastify.get<{ Querystring: { days?: string } }>(
    '/cockpit/events/stats',
    async (request) => {
      const daysRaw = parseInt(request.query.days ?? '30', 10)
      const days = Math.min(90, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 30))
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

      // One groupBy keyed on (action). Fast path because the
      // (entityType, createdAt) index covers the filter.
      const grouped = await prisma.auditLog.groupBy({
        by: ['action'],
        where: { entityType: 'AmazonCockpit', createdAt: { gte: since } },
        _count: { _all: true },
      })

      const counts: Record<string, number> = {}
      for (const row of grouped) counts[row.action] = row._count._all

      // P50 / P95 over market_switched durationMs (read JSON column).
      // Small enough fetch — caps at 2k recent rows to bound cost.
      const switches = await prisma.auditLog.findMany({
        where: {
          entityType: 'AmazonCockpit',
          action: 'market_switched',
          createdAt: { gte: since },
        },
        select: { metadata: true },
        take: 2000,
        orderBy: { createdAt: 'desc' },
      })
      const durations: number[] = []
      for (const s of switches) {
        const m = s.metadata as Record<string, unknown> | null
        const d = m && typeof m === 'object' ? (m as any).durationMs : null
        if (typeof d === 'number' && Number.isFinite(d)) durations.push(d)
      }
      durations.sort((a, b) => a - b)
      const pickP = (p: number) => {
        if (durations.length === 0) return null
        const idx = Math.min(
          durations.length - 1,
          Math.floor((durations.length - 1) * p),
        )
        return durations[idx]
      }

      // Health-score-at-publish: median over publish_submitted events.
      const publishEvents = await prisma.auditLog.findMany({
        where: {
          entityType: 'AmazonCockpit',
          action: 'publish_submitted',
          createdAt: { gte: since },
        },
        select: { metadata: true },
        take: 2000,
        orderBy: { createdAt: 'desc' },
      })
      const scores: number[] = []
      for (const e of publishEvents) {
        const m = e.metadata as Record<string, unknown> | null
        const s = m && typeof m === 'object' ? (m as any).healthScore : null
        if (typeof s === 'number' && Number.isFinite(s)) scores.push(s)
      }
      scores.sort((a, b) => a - b)
      const medianScore = scores.length
        ? scores[Math.floor(scores.length / 2)]
        : null

      const mounts = counts.cockpit_mounted ?? 0
      const classicFlips = counts.classic_toggled ?? 0
      const toggleRate = mounts > 0 ? classicFlips / mounts : null

      return {
        windowDays: days,
        counts,
        marketSwitch: {
          samples: durations.length,
          p50Ms: pickP(0.5),
          p95Ms: pickP(0.95),
        },
        publish: {
          submitted: counts.publish_submitted ?? 0,
          failed: counts.publish_failed ?? 0,
          terminalCount: counts.publish_terminal ?? 0,
          medianHealthAtSubmit: medianScore,
        },
        adoption: {
          mounts,
          classicFlips,
          toggleRate, // null when mounts = 0; else fraction 0..1
        },
        suppression: {
          resolved: counts.suppression_resolved ?? 0,
        },
        autofill: {
          applied: counts.autofill_applied ?? 0,
        },
      }
    },
  )
}

export default cockpitTelemetryRoutes
