/**
 * Phase 0 — outbound push-latency dashboard (complement to RT.3 inbound).
 *
 * Measures OutboundSyncQueue.syncedAt - createdAt per targetChannel over
 * the window. For order-driven QUANTITY_UPDATE rows, createdAt is the
 * cascade time (~the stock movement), so this is the stock-change →
 * channel-confirmed latency. Read-only.
 *
 * GET /api/admin/outbound-latency?window=24h|7d&syncType=QUANTITY_UPDATE
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { buildOutboundLatencyResponse, type OutboundLatencyRow } from '../services/sync-metrics.js'

export default async function outboundLatencyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/outbound-latency', async (req, reply) => {
    reply.header('Cache-Control', 'private, max-age=30')
    const q = req.query as { window?: string; syncType?: string }
    const window = q.window === '7d' ? '7d' : '24h'
    const sinceMs = window === '7d' ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000
    const since = new Date(Date.now() - sinceMs)

    try {
      const rows = (await prisma.outboundSyncQueue.findMany({
        where: {
          createdAt: { gte: since },
          ...(q.syncType ? { syncType: q.syncType } : {}),
        },
        select: { targetChannel: true, createdAt: true, syncedAt: true },
        take: 50_000,
      })) as OutboundLatencyRow[]

      return reply.send(buildOutboundLatencyResponse(rows, window, new Date().toISOString()))
    } catch (err: any) {
      logger.error('[outbound-latency] failed', { message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })
}
