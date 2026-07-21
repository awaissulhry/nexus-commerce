/**
 * Phase 4 — Latency / realtime-health watchdog cron.
 *
 * Runs hourly (default `30 * * * *`; override via
 * NEXUS_LATENCY_WATCHDOG_SCHEDULE; disable via NEXUS_LATENCY_WATCHDOG=0).
 *
 * Two checks per tick:
 *
 * 1. Latency breach — queries the last 24h of OutboundSyncQueue rows
 *    (same select + window as GET /api/admin/outbound-latency), builds
 *    ChannelLatency[] via buildOutboundLatencyResponse, then calls
 *    evaluateLatencyBreach against NEXUS_LATENCY_P95_BREACH_MS (default
 *    60000ms). Publishes `sync.latency.breach` per breached channel so
 *    operator alert machinery surfaces it without a manual dashboard check.
 *
 * 2. Realtime-degraded — reads the same config flags as the diagnostics
 *    route (ENABLE_QUEUE_WORKERS, REDIS_URL/REDIS_HOST,
 *    EBAY_NOTIFICATION_VERIFICATION_TOKEN + active eBay connections) and
 *    emits `sync.realtime.degraded` when the dispatch path is cron-60s-only
 *    or eBay notifications are inactive so the operator knows real-time
 *    sync is not wired correctly.
 *
 * Read-only + emit-only. Never blocks a push. All emits wrapped in
 * try/catch so a bus failure never aborts the cron body.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { publishOrderEvent } from '../services/order-events.service.js'
import prisma from '../db.js'
import {
  buildOutboundLatencyResponse,
  evaluateLatencyBreach,
  type OutboundLatencyRow,
} from '../services/sync-metrics.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

// ── P0c/AS.1 — publish-health tripwires (pure) ──────────────────────────────
// (a) CHANNEL_AUTH_FAILURE: ≥3 auth-class failures (403/Unauthorized/
//     invalid_grant) in the window — the silent-credential-degradation class.
// (b) PUBLISH_FAILURE_RATE: ≥20 attempts AND >20% failed.
// Extracted pure so the decision table is unit-testable; the runner owns
// dedupe + persistence.
export type PublishHealthTrip = {
  channel: string
  conflictType: 'PUBLISH_FAILURE_RATE' | 'CHANNEL_AUTH_FAILURE'
  message: string
  localData: Record<string, number>
}

export function computePublishHealthTrips(
  attempts: Array<{ channel: string; outcome: string; errorMessage: string | null }>,
): PublishHealthTrip[] {
  const byChannel = new Map<string, { ok: number; fail: number; auth: number }>()
  for (const a of attempts) {
    const b = byChannel.get(a.channel) ?? { ok: 0, fail: 0, auth: 0 }
    if (a.outcome === 'success') b.ok++
    else {
      b.fail++
      if (/HTTP 403|Unauthorized|invalid_grant/i.test(a.errorMessage ?? '')) b.auth++
    }
    byChannel.set(a.channel, b)
  }
  const trips: PublishHealthTrip[] = []
  for (const [channel, b] of byChannel) {
    const total = b.ok + b.fail
    if (b.auth >= 3) {
      trips.push({
        channel,
        conflictType: 'CHANNEL_AUTH_FAILURE',
        message: `${b.auth} auth-class publish failures (403/Unauthorized/invalid_grant) in the last hour — check the channel authorization/roles/refresh token`,
        localData: { authFailures: b.auth, windowHours: 1 },
      })
    }
    if (total >= 20 && b.fail / total > 0.2) {
      trips.push({
        channel,
        conflictType: 'PUBLISH_FAILURE_RATE',
        message: `publish failure rate ${Math.round((b.fail / total) * 100)}% (${b.fail}/${total}) in the last hour`,
        localData: { failed: b.fail, total, windowHours: 1 },
      })
    }
  }
  return trips
}

export async function runLatencyWatchdog(): Promise<void> {
  try {
    await recordCronRun('latency-watchdog', async () => {
      const thresholdMs = Number(process.env.NEXUS_LATENCY_P95_BREACH_MS ?? 60_000)
      const since = new Date(Date.now() - 24 * 60 * 60_000)

      // --- 1. Latency breach check ---
      // Reuse the exact select + window from outbound-latency.routes.ts.
      let breachCount = 0
      try {
        const rows = (await prisma.outboundSyncQueue.findMany({
          where: { createdAt: { gte: since } },
          select: { targetChannel: true, createdAt: true, syncedAt: true, syncStatus: true },
          orderBy: { createdAt: 'desc' },
          take: 50_000,
        })) as OutboundLatencyRow[]

        // If we hit the 50k cap the p95 is computed from a recent-biased subset
        // (the window was silently cropped). Surface it so a breach/no-breach
        // verdict under a sustained write burst isn't trusted blindly.
        if (rows.length === 50_000) {
          logger.warn('[latency-watchdog] outbound row cap hit — p95 from a cropped 24h window', {
            cap: 50_000,
          })
        }

        const res = buildOutboundLatencyResponse(rows, '24h', new Date().toISOString())
        const breaches = evaluateLatencyBreach(res.channels, thresholdMs)

        for (const { channel, p95Ms } of breaches) {
          try {
            // RT.7 — persist the breach (the SSE ring buffer dies with the
            // process; operators need breaches to survive restarts).
            void import('../services/sync-health.service.js').then(({ syncHealthService }) =>
              syncHealthService.logConflict({
                channel,
                conflictType: 'LATENCY_BREACH',
                message: `outbound p95 ${Math.round(p95Ms / 1000)}s > ${Math.round(thresholdMs / 1000)}s threshold`,
                localData: { p95Ms, thresholdMs },
                remoteData: { source: 'latency-watchdog', window: '24h' },
              }),
            ).catch(() => {})
            publishOrderEvent({
              type: 'sync.latency.breach',
              channel,
              p95Ms,
              thresholdMs,
              window: '24h',
              ts: Date.now(),
            })
            breachCount++
          } catch (emitErr) {
            logger.warn('[latency-watchdog] failed to publish breach event', {
              channel,
              error: emitErr instanceof Error ? emitErr.message : String(emitErr),
            })
          }
        }

        if (breaches.length > 0) {
          logger.warn('[latency-watchdog] latency breach(es) detected', {
            breaches: breaches.map((b) => `${b.channel}:p95=${b.p95Ms}ms`),
            thresholdMs,
          })
        }
      } catch (queryErr) {
        logger.error('[latency-watchdog] latency query failed', {
          error: queryErr instanceof Error ? queryErr.message : String(queryErr),
        })
      }

      // --- 2. Publish-health tripwires (P0c, un-nested by AS.1) ---
      // These MUST run every tick regardless of dispatch path. They were
      // accidentally nested inside the `if (!immediate)` degraded branch, so
      // on a healthy instant-lane deploy (the normal prod config) they never
      // executed — the 2026-07-20 403 outage produced zero CHANNEL_AUTH_FAILURE
      // rows while 14 auth failures sat in the attempts audit.
      let tripwireCount = 0
      try {
        const oneHourAgo = new Date(Date.now() - 3600e3)
        const attempts = await prisma.channelPublishAttempt.findMany({
          where: { attemptedAt: { gte: oneHourAgo }, outcome: { in: ['success', 'failed'] } },
          select: { channel: true, outcome: true, errorMessage: true },
        })
        const trips = computePublishHealthTrips(attempts)
        const { syncHealthService } = await import('../services/sync-health.service.js')
        for (const trip of trips) {
          const dupe = await prisma.syncHealthLog.findFirst({
            where: {
              channel: trip.channel,
              conflictType: trip.conflictType,
              resolutionStatus: 'UNRESOLVED',
              createdAt: { gte: new Date(Date.now() - 6 * 3600e3) },
            },
            select: { id: true },
          })
          if (dupe) continue
          await syncHealthService.logConflict({
            channel: trip.channel,
            conflictType: trip.conflictType,
            message: trip.message,
            localData: trip.localData,
            remoteData: { source: 'latency-watchdog' },
          })
          tripwireCount++
          logger.warn('[latency-watchdog] publish-health tripwire fired', {
            channel: trip.channel,
            conflictType: trip.conflictType,
            message: trip.message,
          })
        }
      } catch (healthErr) {
        logger.warn('[latency-watchdog] publish-health tripwires failed', {
          error: healthErr instanceof Error ? healthErr.message : String(healthErr),
        })
      }

      // --- 3. Realtime-degraded check ---
      // Mirror the exact config reads from inventory-sync-diagnostics.routes.ts.
      let degradedCount = 0

      const queueWorkersEnabled = process.env.ENABLE_QUEUE_WORKERS === '1'
      const redisConfigured = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST)
      const immediate = queueWorkersEnabled && redisConfigured

      if (!immediate) {
        const reason = !queueWorkersEnabled
          ? 'Outbound queue workers are OFF (ENABLE_QUEUE_WORKERS !== "1") — cross-channel push bounded by 60s cron, not real-time'
          : 'Redis not configured (REDIS_URL / REDIS_HOST unset) — BullMQ workers cannot start'
        try {
          publishOrderEvent({ type: 'sync.realtime.degraded', reason, ts: Date.now() })
          degradedCount++
        } catch (emitErr) {
          logger.warn('[latency-watchdog] failed to publish dispatch-path degraded event', {
            reason,
            error: emitErr instanceof Error ? emitErr.message : String(emitErr),
          })
        }
        logger.warn('[latency-watchdog] realtime sync degraded (dispatch path)', { reason })
      }

      // eBay notification readiness — mirrors diagnostics route exactly.
      try {
        const activeEbay: number = await (prisma as any).channelConnection.count({
          where: { channelType: 'EBAY', isActive: true },
        })
        const ebayNotificationsActive: boolean | null =
          activeEbay > 0 ? Boolean(process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN) : null

        if (ebayNotificationsActive === false) {
          const reason =
            'eBay Platform Notifications inactive — active eBay connection present but EBAY_NOTIFICATION_VERIFICATION_TOKEN not set; eBay sales may lag up to 15min'
          try {
            publishOrderEvent({ type: 'sync.realtime.degraded', reason, ts: Date.now() })
            degradedCount++
          } catch (emitErr) {
            logger.warn('[latency-watchdog] failed to publish eBay degraded event', {
              error: emitErr instanceof Error ? emitErr.message : String(emitErr),
            })
          }
          logger.warn('[latency-watchdog] realtime sync degraded (eBay notifications)', { reason })
        }
      } catch (ebayErr) {
        logger.error('[latency-watchdog] eBay notification check failed', {
          error: ebayErr instanceof Error ? ebayErr.message : String(ebayErr),
        })
      }

      // --- 4. SC.5: new-listing default enforcement ---
      // Idempotent + resume-sticky (see enforceNewListingDefaults). One tiny
      // policy query when no PAUSED-default policy exists.
      let newListingPaused = 0
      try {
        const { enforceNewListingDefaults } = await import('../services/sync-control-policy.service.js')
        const swept = await enforceNewListingDefaults()
        newListingPaused = swept.paused
        if (swept.paused > 0) logger.info('[latency-watchdog] paused new listings per policy', swept)
      } catch (sweepErr) {
        logger.error('[latency-watchdog] new-listing sweep failed', {
          error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
        })
      }

      return `breaches=${breachCount} tripwires=${tripwireCount} degraded=${degradedCount} newListingPaused=${newListingPaused} thresholdMs=${thresholdMs}`
    })
  } catch (err) {
    logger.error('[latency-watchdog] top-level failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startLatencyWatchdogCron(): void {
  if (process.env.NEXUS_LATENCY_WATCHDOG === '0') {
    logger.info('latency-watchdog cron: disabled via NEXUS_LATENCY_WATCHDOG=0')
    return
  }
  if (scheduledTask) {
    logger.warn('latency-watchdog cron already started — skipping')
    return
  }

  const schedule = process.env.NEXUS_LATENCY_WATCHDOG_SCHEDULE ?? '30 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('latency-watchdog cron: invalid schedule expression', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runLatencyWatchdog()
  })

  logger.info('latency-watchdog cron: started', { schedule })
}
