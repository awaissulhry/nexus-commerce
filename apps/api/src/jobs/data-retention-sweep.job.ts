/**
 * Phase H follow-up — data retention sweep.
 *
 * Reads DataRetentionPolicy.policies (set in /settings/privacy) and
 * deletes eligible non-webhook rows and archives completed inbound deliveries.
 *
 * Schedule: '0 3 * * *' UTC (03:00). Same nightly window as the
 * other purge jobs; after Neon's maintenance, before the morning
 * shift. Single tx per data-type so a partial failure on one table
 * (e.g. an FK gripe) doesn't roll back the whole sweep.
 *
 * Default-on; opt out via NEXUS_ENABLE_RETENTION_SWEEP=0.
 *
 * eBay deletion notices no business still needs expire in a separate platform tick on the
 * same schedule (fixed period, not a business policy; see ebay-erasure-review.ts).
 *
 * Conservative: anything we don't have an entry for is left alone.
 * If the user wants a new data-type swept, add it to the
 * SWEEP_TABLES map AND set a policy value via the UI.
 */

import cron, { schedulePlatform } from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { archiveCompletedInbound, scrubExpiredInbound } from '../services/cx/ingress/archive.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let noticeExpiryTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: SweepSummary | null = null

interface SweepSummary {
  scannedKeys: number
  deletedByKey: Record<string, number>
  skippedKeys: string[]
  totalDeleted: number
  archivedByKey: Record<string, number>
  totalArchived: number
  archiveLimitReached: boolean
  scrubbedByKey: Record<string, number>
  scrubLimitReached: boolean
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
  { model: string; ts: 'createdAt' | 'updatedAt'; only?: Record<string, unknown> }
> = {
  auditLog: { model: 'auditLog', ts: 'createdAt' },
  loginEvents: { model: 'loginEvent', ts: 'createdAt' },
  // webhookEvents is never deleted here: Package A archives inbound history in place
  // (archiveCompletedInbound below) and a DELETE/TRUNCATE trigger refuses deletion.
  stockLogs: { model: 'stockLog', ts: 'createdAt' },
  // exports retention sweeps the DataExportRequest table by
  // completedAt (so freshly-queued requests don't get yanked).
  exports: { model: 'dataExportRequest', ts: 'createdAt' },
}

/**
 * Rows whose lifetime the code that writes them fixes, not the privacy policy. They
 * are swept even when no policy row exists.
 */
async function sweepExpiredOperationalRows(summary: SweepSummary): Promise<void> {
  try {
    // Idempotency receipts (lib/command-idempotency.ts) are useless once expired.
    const r = await prisma.commandReceipt.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    summary.deletedByKey.commandReceipts = r.count
    summary.totalDeleted += r.count
  } catch (err) {
    summary.skippedKeys.push(`commandReceipts (error: ${err instanceof Error ? err.message : String(err)})`)
  }
}

export async function runRetentionSweepOnce(): Promise<SweepSummary> {
  const summary: SweepSummary = {
    scannedKeys: 0,
    deletedByKey: {},
    skippedKeys: [],
    totalDeleted: 0,
    archivedByKey: {},
    totalArchived: 0,
    archiveLimitReached: false,
    scrubbedByKey: {},
    scrubLimitReached: false,
  }
  if (process.env.NEXUS_ENABLE_RETENTION_SWEEP === '0') {
    lastRunAt = new Date()
    lastSummary = summary
    return summary
  }

  await sweepExpiredOperationalRows(summary)

  // Single-row policy table; read once.
  const policyRow = await (prisma as any).dataRetentionPolicy.findFirst()
  if (!policyRow) {
    summary.skippedKeys.push('(no policy row — nothing to sweep)')
    lastRunAt = new Date()
    lastSummary = summary
    return summary
  }
  const policies = (policyRow.policies as Record<string, unknown>) ?? {}

  // D8: completed inbound history is retained in place. Never send this model
  // through the generic deletion delegate, even if archive persistence fails.
  summary.scannedKeys++
  const inboundDays = policies.webhookEvents
  if (typeof inboundDays === 'number' && Number.isSafeInteger(inboundDays) && inboundDays >= 0) {
    try {
      const result = await archiveCompletedInbound(inboundDays)
      summary.archivedByKey.webhookEvents = result.archived
      summary.totalArchived = result.archived
      summary.archiveLimitReached = result.limitReached
    } catch {
      summary.skippedKeys.push('webhookEvents (archive unavailable; history retained)')
    }
    // Bounded retention of the personal data in retained rows (rawBody, payload, headers).
    try {
      const scrub = await scrubExpiredInbound(inboundDays)
      summary.scrubbedByKey.webhookEvents = scrub.scrubbed
      summary.scrubLimitReached = scrub.limitReached
    } catch {
      summary.skippedKeys.push('webhookEvents (payload expiry unavailable; retried next run)')
    }
  } else summary.skippedKeys.push('webhookEvents (no valid archive policy)')

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
        where: { [def.ts]: { lt: cutoff }, ...def.only },
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
  scheduledTask = cron.schedule(schedule, async () => {
    if (process.env.NEXUS_ENABLE_RETENTION_SWEEP === '0') return
    await recordCronRun('retention-sweep', async () => {
      const r = await runRetentionSweepOnce()
      return `keys=${r.scannedKeys} deleted=${r.totalDeleted} archived=${r.totalArchived} archiveLimitReached=${r.archiveLimitReached} scrubbed=${r.scrubbedByKey.webhookEvents ?? 0} scrubLimitReached=${r.scrubLimitReached} skipped=${r.skippedKeys.length}`
    }).catch((err) => {
      logger.error('retention-sweep: top-level failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  // eBay deletion notices no business still needs expire on a fixed period (not a business
  // policy). They belong to no business, so one platform tick runs it. Dormant unless the
  // privacy review switch is exactly 1 (the expiry itself checks it again).
  noticeExpiryTask = schedulePlatform(schedule, async () => {
    if (process.env.NEXUS_ENABLE_RETENTION_SWEEP === '0' || process.env.NEXUS_ENABLE_EBAY_PRIVACY_REVIEW !== '1') return
    await recordCronRun('ebay-deletion-notice-expiry', async () => {
      const { expireEbayDeletionNotices } = await import('../services/cx/ingress/ebay-erasure-review.js')
      const result = await expireEbayDeletionNotices()
      return result.kind === 'held' ? 'held' : `expired=${result.expired} limitReached=${result.limitReached}`
    }).catch((err) => {
      logger.error('ebay-deletion-notice-expiry: failure', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  logger.info('retention-sweep cron: scheduled', { schedule })
}

export function stopRetentionSweepCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
  if (noticeExpiryTask) {
    noticeExpiryTask.stop()
    noticeExpiryTask = null
  }
}

export function getRetentionSweepStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
