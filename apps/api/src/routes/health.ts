import type { FastifyPluginAsync } from 'fastify'
import { createHash } from 'node:crypto'
import prisma from '../db.js'
import { getRedisRuntimeStatus } from '../lib/queue.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { checkDatabaseReadiness, servingBuild } from '../services/health.service.js'

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
  // Cutover depends on the database being reachable. Operational diagnostics on
  // /health can scan queue/ads history and must not delay the infrastructure probe.
  fastify.get('/health/ready', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    try {
      await checkDatabaseReadiness()
      return {
        status: 'healthy',
        build: servingBuild(),
        services: { database: 'connected', api: 'operational' },
      }
    } catch {
      return reply.code(503).send({ status: 'unhealthy', error: 'Database is unavailable' })
    }
  })

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
      let alertsError: string | undefined
      let adsIntegrity: { severity: string; findings: Array<{ code: string; severity: string; message: string; action: string }> } | undefined
      let adsIntegrityError: string | undefined
      try {
        const dayAgo = new Date(Date.now() - 24 * 3600e3)
        // Business profiles: this route is PUBLIC and runs with no profile, and every table below is
        // profile-scoped — so each count is summed across active profiles. Until 2026-09-16 these threw
        // `workspace_required` and the catch made the whole alarm block vanish from production health.
        const totals = { authFailures: 0, publishFailureRate: 0, qtyMismatches: 0, deadLetters24h: 0, adsDeadLetters24h: 0 }
        await visitActiveWorkspaces(async () => {
          const [authFailures, publishFailureRate, qtyMismatches, deadLetters24h, adsDeadLetters24h] = await Promise.all([
            prisma.syncHealthLog.count({
              where: { conflictType: 'CHANNEL_AUTH_FAILURE', resolutionStatus: 'UNRESOLVED', createdAt: { gte: dayAgo } },
            }),
            prisma.syncHealthLog.count({
              where: { conflictType: 'PUBLISH_FAILURE_RATE', resolutionStatus: 'UNRESOLVED', createdAt: { gte: dayAgo } },
            }),
            prisma.syncHealthLog.count({
              where: { conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED', createdAt: { gte: dayAgo } },
            }),
            // SC.5-fix — ads-lane corpses (AD_* syncTypes, e.g. bid updates for
            // Amazon-deleted entities) are not inventory risk: count separately
            // so the inventory dead-letter tripwire stays meaningful.
            prisma.outboundSyncQueue.count({ where: { isDead: true, diedAt: { gte: dayAgo }, NOT: { syncType: { startsWith: 'AD_' } } } }),
            prisma.outboundSyncQueue.count({ where: { isDead: true, diedAt: { gte: dayAgo }, syncType: { startsWith: 'AD_' } } }),
          ])
          totals.authFailures += authFailures
          totals.publishFailureRate += publishFailureRate
          totals.qtyMismatches += qtyMismatches
          totals.deadLetters24h += deadLetters24h
          totals.adsDeadLetters24h += adsDeadLetters24h
        })
        alerts = totals
        // AX2.9 — the ads spine self-reports so nobody has to check it daily. Per profile; the worst wins.
        try {
          const { runSyncIntegrityCheck } = await import('../services/advertising/ads-sync-integrity.service.js')
          const rank = { OK: 0, WARN: 1, CRITICAL: 2 } as const
          let severity: keyof typeof rank = 'OK'
          const findings: Array<{ code: string; severity: string; message: string; action: string }> = []
          await visitActiveWorkspaces(async () => {
            const integrity = await runSyncIntegrityCheck()
            if (rank[integrity.severity] > rank[severity]) severity = integrity.severity
            findings.push(...integrity.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message, action: f.action })))
          })
          adsIntegrity = { severity, findings }
        } catch {
          // Fail-open for health, but never silently: an absent block used to read as "nothing wrong".
          adsIntegrityError = 'Ads sync integrity could not be checked'
        }
      } catch {
        alerts = undefined
        alertsError = 'Alarm counts could not be read'
      }

      return {
        status: 'healthy',
        // Deploy/version markers — so we can verify which build + which Amazon
        // publish-gate state is actually live. The FBA→FBM flip incident showed we
        // were toggling the gate blind to whether the fix had deployed.
        build: servingBuild(),
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
        ...(alertsError ? { alertsError } : {}),
        // AX2.9 — the Amazon ads spine self-reports. severity 'OK' with no
        // findings is the steady state; anything else names the problem AND the
        // next step, so this never needs a daily manual check.
        ...(adsIntegrity ? { adsIntegrity } : {}),
        ...(adsIntegrityError ? { adsIntegrityError } : {}),
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
