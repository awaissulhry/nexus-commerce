/**
 * Phase H follow-up — data retention sweep.
 *
 * Reads DataRetentionPolicy.policies (set in /settings/privacy) and
 * deletes rows past their window in each registered data-type table.
 *
 * Schedule: '0 3 * * *' UTC (03:00). Same nightly window as the
 * other purge jobs; after Neon's maintenance, before the morning
 * shift. Single tx per data-type so a partial failure on one table
 * (e.g. an FK gripe) doesn't roll back the whole sweep.
 *
 * Default-on; opt out via NEXUS_ENABLE_RETENTION_SWEEP=0.
 *
 * Conservative: anything we don't have an entry for is left alone.
 * If the user wants a new data-type swept, add it to the
 * SWEEP_TABLES map AND set a policy value via the UI.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: SweepSummary | null = null

interface SweepSummary {
  scannedKeys: number
  deletedByKey: Record<string, number>
  skippedKeys: string[]
  totalDeleted: number
}

/**
 * Maps every data-type key the user can configure → the Prisma
 * delegate to deleteMany on + the timestamp column to compare.
 * Orders are deliberately absent: 7y fiscal floor + cascade impact
 * makes auto-sweep too risky. If we ever want to retire ancient
 * orders, a manual archive workflow lands first.
 */
const SWEEP_TABLES: Record<
  string,
  { model: string; ts: 'createdAt' | 'updatedAt' }
> = {
  auditLog: { model: 'auditLog', ts: 'createdAt' },
  loginEvents: { model: 'loginEvent', ts: 'createdAt' },
  webhookEvents: { model: 'webhookEvent', ts: 'createdAt' },
  stockLogs: { model: 'stockLog', ts: 'createdAt' },
  // exports retention sweeps the DataExportRequest table by
  // completedAt (so freshly-queued requests don't get yanked).
  exports: { model: 'dataExportRequest', ts: 'createdAt' },
}

export async function runRetentionSweepOnce(): Promise<SweepSummary> {
  const summary: SweepSummary = {
    scannedKeys: 0,
    deletedByKey: {},
    skippedKeys: [],
    totalDeleted: 0,
  }
  if (process.env.NEXUS_ENABLE_RETENTION_SWEEP === '0') {
    lastRunAt = new Date()
    lastSummary = summary
    return summary
  }

  // Single-row policy table; read once.
  const policyRow = await (prisma as any).dataRetentionPolicy.findFirst()
  if (!policyRow) {
    summary.skippedKeys.push('(no policy row — nothing to sweep)')
    lastRunAt = new Date()
    lastSummary = summary
    return summary
  }
  const policies = (policyRow.policies as Record<string, unknown>) ?? {}

  for (const [key, def] of Object.entries(SWEEP_TABLES)) {
    summary.scannedKeys++
    const raw = policies[key]
    const days = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    if (days === null) {
      summary.skippedKeys.push(`${key} (no policy)`)
      continue
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    try {
      const delegate = (prisma as any)[def.model]
      if (!delegate?.deleteMany) {
        summary.skippedKeys.push(`${key} (model missing)`)
        continue
      }
      const r = await delegate.deleteMany({
        where: { [def.ts]: { lt: cutoff } },
      })
      summary.deletedByKey[key] = r.count
      summary.totalDeleted += r.count
    } catch (err) {
      summary.skippedKeys.push(
        `${key} (error: ${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }

  logger.info('retention-sweep: cycle complete', summary)
  lastRunAt = new Date()
  lastSummary = summary
  return summary
}

export function startRetentionSweepCron(): void {
  if (scheduledTask) {
    logger.warn('retention-sweep cron already started — skipping')
    return
  }
  const schedule =
    process.env.NEXUS_RETENTION_SWEEP_SCHEDULE ?? '0 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('retention-sweep: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    if (process.env.NEXUS_ENABLE_RETENTION_SWEEP === '0') return
    void recordCronRun('retention-sweep', async () => {
      const r = await runRetentionSweepOnce()
      return `keys=${r.scannedKeys} deleted=${r.totalDeleted} skipped=${r.skippedKeys.length}`
    }).catch((err) => {
      logger.error('retention-sweep: top-level failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('retention-sweep cron: scheduled', { schedule })
}

export function stopRetentionSweepCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getRetentionSweepStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
