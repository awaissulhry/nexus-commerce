import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { getRedisRuntimeStatus } from '../lib/queue.js'

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
        dispatchPath: workersEnabled && redisConnected ? 'immediate-bullmq' : 'cron-60s-only',
        timestamp: new Date().toISOString(),
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
