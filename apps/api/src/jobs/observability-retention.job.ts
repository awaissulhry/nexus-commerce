/**
 * L.4.0 — Observability retention cron.
 *
 * Trims the high-volume observability tables to a rolling window so
 * storage doesn't grow unbounded:
 *
 *   OutboundApiCallLog   90 days (estimate 1.7M/yr at full
 *                                 instrumentation; 90d ≈ 420k rows)
 *   CronRun              90 days (35 jobs × ~30 ticks/day = 1k/day,
 *                                 90d ≈ 90k rows)
 *
 * AuditLog is intentionally NOT trimmed here — the mutation history
 * has compliance value and a separate retention policy (planned
 * along with L.9 audit immutability).
 *
 * SyncLog / SyncHealthLog / WebhookEvent / SyncError currently sit
 * at 0 rows in production but will be touched by the same cron once
 * those surfaces are wired (Phase L.5 / L.6).
 *
 * Schedule: daily 04:00 UTC. Sequenced after the heavy nightly jobs
 * (sales-report-ingest 02:00, forecast 03:30, forecast-accuracy
 * 04:00) to avoid lock contention on the shared write paths during
 * peak ingest. Manual trigger via the exported function.
 *
 * Default-ON. Set NEXUS_DISABLE_OBSERVABILITY_RETENTION=1 to opt out
 * (e.g. during forensic investigation when long history is needed).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const DEFAULT_DAYS = 90

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

interface RetentionResult {
  apiCallsDeleted: number
  cronRunsDeleted: number
  windowDays: number
  durationMs: number
}

export async function runObservabilityRetention(): Promise<RetentionResult> {
  const startedAt = Date.now()
  const days = Number(process.env.NEXUS_OBSERVABILITY_RETENTION_DAYS) || DEFAULT_DAYS
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // OutboundApiCallLog — high-volume table. Use deleteMany; the
  // (createdAt) index makes this efficient.
  const apiCalls = await prisma.outboundApiCallLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })

  // CronRun — keep 90d so the dashboard's history charts have data.
  // Stale RUNNING rows older than 2h are flagged in /api/dashboard/cron-runs;
  // we don't auto-clean them here so the operator can see them as red flags
  // before they're trimmed by the rolling window.
  const cronRuns = await prisma.cronRun.deleteMany({
    where: { startedAt: { lt: cutoff } },
  })

  const durationMs = Date.now() - startedAt
  const result: RetentionResult = {
    apiCallsDeleted: apiCalls.count,
    cronRunsDeleted: cronRuns.count,
    windowDays: days,
    durationMs,
  }

  logger.info('observability-retention: complete', result)
  return result
}

export function startObservabilityRetentionCron(): void {
  if (scheduledTask) {
    logger.warn('observability-retention cron already started — skipping')
    return
  }
  if (process.env.NEXUS_DISABLE_OBSERVABILITY_RETENTION === '1') {
    logger.info('observability-retention: disabled via env')
    return
  }

  // Default 04:00 UTC daily. Override via NEXUS_OBSERVABILITY_RETENTION_SCHEDULE.
  const schedule =
    process.env.NEXUS_OBSERVABILITY_RETENTION_SCHEDULE ?? '0 4 * * *'

  if (!cron.validate(schedule)) {
    logger.error('observability-retention cron: invalid schedule', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun('observability-retention', async () => {
      const r = await runObservabilityRetention()
      return `apiCalls=${r.apiCallsDeleted} cronRuns=${r.cronRunsDeleted} window=${r.windowDays}d durationMs=${r.durationMs}`
    }).catch((err) => {
      logger.error('observability-retention cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })

  logger.info('observability-retention cron: scheduled', { schedule })
}

export function stopObservabilityRetentionCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
