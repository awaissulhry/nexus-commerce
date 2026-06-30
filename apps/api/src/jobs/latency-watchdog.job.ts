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

        const res = buildOutboundLatencyResponse(rows, '24h', new Date().toISOString())
        const breaches = evaluateLatencyBreach(res.channels, thresholdMs)

        for (const { channel, p95Ms } of breaches) {
          try {
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

      // --- 2. Realtime-degraded check ---
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

      return `breaches=${breachCount} degraded=${degradedCount} thresholdMs=${thresholdMs}`
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
