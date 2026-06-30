/**
 * Phase 0 — consolidated inventory-sync diagnostics. One call answers
 * "is real-time sync actually wired right now?": dispatch path (immediate
 * BullMQ vs 60s cron), eBay notification readiness, queue backlog, DLQ
 * depth, and the last run of the key inventory crons. Read-only.
 *
 * GET /api/admin/inventory-sync/diagnostics
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { summarizeDiagnostics, type DiagnosticsInput } from '../services/sync-metrics.js'

const CRON_NAMES = [
  'sync-drift-detection',
  'fba-flip-guard',
  'reservation-sweep',
  'amazon-inventory-sync',
  'ebay-orders-sync',
]

export default async function inventorySyncDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/inventory-sync/diagnostics', async (_req, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    try {
      const now = Date.now()

      const queueWorkersEnabled = process.env.ENABLE_QUEUE_WORKERS === '1'
      const redisConfigured = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST)
      const amazonPublishLive =
        process.env.NEXUS_ENABLE_AMAZON_PUBLISH === 'true' && process.env.AMAZON_PUBLISH_MODE === 'live'
      const shopifyPublishLive =
        process.env.NEXUS_ENABLE_SHOPIFY_PUBLISH === 'true' && process.env.SHOPIFY_PUBLISH_MODE === 'live'

      const [activeEbay, oldestPending, outboundPending, dlqDepth, cronRows] = await Promise.all([
        (prisma as any).channelConnection.count({ where: { channelType: 'EBAY', isActive: true } }),
        prisma.outboundSyncQueue.findFirst({
          where: { syncStatus: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        prisma.outboundSyncQueue.count({ where: { syncStatus: 'PENDING' } }),
        prisma.outboundSyncQueue.count({ where: { isDead: true } }),
        Promise.all(
          CRON_NAMES.map(async (name) => {
            const row = await prisma.cronRun.findFirst({
              where: { jobName: name },
              orderBy: { startedAt: 'desc' },
              select: { startedAt: true, status: true },
            })
            return {
              name,
              lastRunAt: row?.startedAt ? row.startedAt.toISOString() : null,
              lastStatus: row?.status ?? null,
              ageMs: row?.startedAt ? now - row.startedAt.getTime() : null,
            }
          }),
        ),
      ])

      const ebayNotificationsActive: boolean | null =
        activeEbay > 0 ? Boolean(process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN) : null

      const input: DiagnosticsInput = {
        queueWorkersEnabled,
        redisConfigured,
        ebayNotificationsActive,
        shopifyPublishLive,
        amazonPublishLive,
        outboundPending,
        outboundOldestPendingAgeMs: oldestPending ? now - oldestPending.createdAt.getTime() : null,
        dlqDepth,
        crons: cronRows,
      }

      return reply.send(summarizeDiagnostics(input, new Date().toISOString()))
    } catch (err: any) {
      logger.error('[inventory-sync diagnostics] failed', { message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })
}
