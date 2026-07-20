import type { FastifyPluginAsync } from 'fastify'
import { createHash } from 'node:crypto'
import prisma from '../db.js'
import { getRedisRuntimeStatus } from '../lib/queue.js'

// AS.0 debugging — a stable, non-reversible fingerprint of the Amazon refresh
// token the RUNNING process actually holds (first 8 hex of sha256). Lets us
// verify remotely that a Railway variable change was truly applied, without
// exposing anything about the secret itself.
function amazonTokenFingerprint(): string {
  const t = process.env.AMAZON_REFRESH_TOKEN ?? ''
  if (!t) return 'unset'
  return createHash('sha256').update(t).digest('hex').slice(0, 8)
}

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (request, reply) => {
    try {
      // Test database connection
      await prisma.$queryRaw`SELECT 1`

      // RT.1 — REAL Redis state (the old response hardcoded 'connected' and
      // hid a months-long dead instant lane). getRedisRuntimeStatus reads the
      // ioredis client's live status without issuing a command, so this can
      // never hang on an unreachable Redis. Redis being down does NOT fail
      // health — the DB is the only hard dependency; the 60s drain cron keeps
      // sync working without Redis.
      const redisInfo = getRedisRuntimeStatus()
      const redisConnected = redisInfo.status === 'ready'
      const workersEnabled = process.env.ENABLE_QUEUE_WORKERS === '1'

      // AS.2-lite — the alarm state, on the one URL everyone already checks.
      // SyncHealthLog rows were write-only (no UI reader anywhere), so the
      // 2026-07-20 403 outage was invisible outside the DB. Fail-open: alert
      // lookup errors never break health.
      let alerts: Record<string, number> | undefined
      try {
        const dayAgo = new Date(Date.now() - 24 * 3600e3)
        const [authFailures, publishFailureRate, qtyMismatches, deadLetters24h] = await Promise.all([
          prisma.syncHealthLog.count({
            where: { conflictType: 'CHANNEL_AUTH_FAILURE', resolutionStatus: 'UNRESOLVED', createdAt: { gte: dayAgo } },
          }),
          prisma.syncHealthLog.count({
            where: { conflictType: 'PUBLISH_FAILURE_RATE', resolutionStatus: 'UNRESOLVED', createdAt: { gte: dayAgo } },
          }),
          prisma.syncHealthLog.count({
            where: { conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED', createdAt: { gte: dayAgo } },
          }),
          prisma.outboundSyncQueue.count({ where: { isDead: true, diedAt: { gte: dayAgo } } }),
        ])
        alerts = { authFailures, publishFailureRate, qtyMismatches, deadLetters24h }
      } catch {
        alerts = undefined
      }

      return {
        status: 'healthy',
        // Deploy/version markers — so we can verify which build + which Amazon
        // publish-gate state is actually live. The FBA→FBM flip incident showed we
        // were toggling the gate blind to whether the fix had deployed.
        build: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) ?? 'unknown',
        marker: 'fba-flip-fix-2026-06-18',
        amazonPublish: process.env.NEXUS_ENABLE_AMAZON_PUBLISH === 'true' ? 'ENABLED' : 'gated',
        // RT.1 — remotely-verifiable dispatch mode: 'immediate-bullmq' means
        // the instant lane is genuinely live (workers on AND Redis connected).
        queueWorkers: workersEnabled ? 'enabled' : 'disabled',
        amazonTokenFp: amazonTokenFingerprint(),
        dispatchPath: workersEnabled && redisConnected ? 'immediate-bullmq' : 'cron-60s-only',
        timestamp: new Date().toISOString(),
        // AS.2-lite — non-zero numbers here mean "open the sync-health data".
        ...(alerts ? { alerts } : {}),
        services: {
          database: 'connected',
          redis: redisConnected
            ? 'connected'
            : redisInfo.configured
              ? `unreachable(${redisInfo.status})`
              : 'not-configured',
          api: 'operational',
        },
      }
    } catch (error) {
      return reply.code(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  })
}

export default healthRoutes
