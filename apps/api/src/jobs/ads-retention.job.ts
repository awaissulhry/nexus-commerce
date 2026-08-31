/**
 * HX.11 — retention for the ads history tables.
 *
 * Built now, while the account is small, precisely because it is easier to prove correct against
 * 30k rows than against a million. Nothing is old enough to prune today (the oldest ads history is
 * 2026-05-31), so the first live runs will report zero — which is the point: the policy is in place
 * and observable before it ever has work to do.
 *
 * PER-TABLE WINDOWS, because these tables answer different questions and one number would be wrong
 * for most of them:
 *
 *   · OutboundSyncQueue — a WORK QUEUE, not history. A settled row is residue; the audit trail
 *     lives in AdvertisingActionLog and CampaignBidHistory. Pruned hardest. FAILED rows are kept
 *     longer because they are diagnostic.
 *   · AdMutation — the delivery record ("did Amazon take it"). Useful while a change is recent
 *     enough to still be worth chasing; FAILED again kept longer.
 *   · CampaignBidHistory / AdvertisingActionLog — the actual audit trail the Change Log reads.
 *     Two years, matching Google Ads' change history, which is the longest window any comparable
 *     product offers.
 *   · AdDrift — only RESOLVED rows; an open drift is a live finding regardless of age.
 *
 * WHAT PRUNING COSTS, stated because it is not obvious: AdvertisingActionLog.payloadBefore is the
 * rollback anchor. Anything pruned can never be undone. The two-year window is far outside any
 * undo horizon we offer (24h for target bids), so this is safe — but it stops being safe if
 * somebody shortens the window without knowing that.
 */

import cron from '../lib/cron/clustered.js'
import { OutboundSyncStatus } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const DAY = 24 * 60 * 60 * 1000

/** Every window in one place, so changing policy is a one-line review rather than a code hunt. */
export const RETENTION_DAYS = {
  /** Settled queue rows: the work is done and recorded elsewhere. */
  outboundSettled: 30,
  /** Failed queue rows: diagnostic — the six-day routing bug was found in exactly these. */
  outboundFailed: 90,
  /** Settled typed writes. */
  mutationSettled: 90,
  /** Failed typed writes: same diagnostic argument. */
  mutationFailed: 180,
  /** The audit trail proper. Google Ads keeps 2 years; nothing comparable keeps more. */
  bidHistory: 730,
  actionLog: 730,
  /** Resolved drift only. An OPEN drift row is a live finding at any age and is never pruned. */
  driftResolved: 90,
  /**
   * ADM-P6 — budget-usage readings. Pruned on `lastSeenAt`, never `usageUpdatedAt`: the second is
   * AMAZON's clock and a redelivered old reading would otherwise be born prunable.
   *
   * 90 days, matching Amazon's own report-retention wall, and far outside anything that reads
   * these: the hour columns look at the CURRENT budget day only, so today's readings are the only
   * ones with a consumer. History is kept anyway because neither source can be backfilled — an
   * hour thrown away here can never be recovered from Amazon, unlike almost everything else in
   * this file, which can be re-fetched.
   *
   * Rate measured 2026-08-22: ~43 rows/hour across 200 campaigns, so ~1,000/day and ~90k at
   * steady state under this window.
   */
  budgetUsageSample: 90,
} as const

/**
 * Deleting is bounded per table per run. A first run against a table that has grown for a year
 * would otherwise be a single enormous statement holding locks on a table the write path uses.
 */
const BATCH = 5_000

export interface RetentionResult {
  dryRun: boolean
  deleted: Record<string, number>
  total: number
  cappedTables: string[]
}

const cutoff = (days: number) => new Date(Date.now() - days * DAY)

export async function runAdsRetentionOnce(opts: { dryRun?: boolean } = {}): Promise<RetentionResult> {
  const dryRun = opts.dryRun ?? true // safe by default: callers must ASK to delete
  const deleted: Record<string, number> = {}
  const cappedTables: string[] = []

  const sweep = async (
    label: string,
    count: () => Promise<number>,
    del: (ids: string[]) => Promise<number>,
    ids: () => Promise<Array<{ id: string }>>,
  ) => {
    try {
      const n = await count()
      if (n === 0) { deleted[label] = 0; return }
      if (dryRun) { deleted[label] = n; if (n > BATCH) cappedTables.push(label); return }
      const rows = await ids()
      const removed = rows.length ? await del(rows.map((r) => r.id)) : 0
      deleted[label] = removed
      // More remained than one batch could take; the next scheduled run picks up the rest rather
      // than this one running long.
      if (n > removed) cappedTables.push(label)
    } catch (e) {
      logger.warn('[ads-retention] sweep failed', { table: label, error: (e as Error).message })
      deleted[label] = 0
    }
  }

  // ── OutboundSyncQueue ──────────────────────────────────────────────────────
  // Typed against the enum rather than strings, so an invented status is a compile error
  // instead of a filter that silently matches nothing.
  const settledStatuses: OutboundSyncStatus[] = [OutboundSyncStatus.SUCCESS, OutboundSyncStatus.CANCELLED, OutboundSyncStatus.SKIPPED]
  await sweep(
    'outboundSyncQueue.settled',
    () => prisma.outboundSyncQueue.count({ where: { syncStatus: { in: settledStatuses }, createdAt: { lt: cutoff(RETENTION_DAYS.outboundSettled) } } }),
    (ids) => prisma.outboundSyncQueue.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.outboundSyncQueue.findMany({ where: { syncStatus: { in: settledStatuses }, createdAt: { lt: cutoff(RETENTION_DAYS.outboundSettled) } }, select: { id: true }, take: BATCH }),
  )
  await sweep(
    'outboundSyncQueue.failed',
    () => prisma.outboundSyncQueue.count({ where: { syncStatus: OutboundSyncStatus.FAILED, createdAt: { lt: cutoff(RETENTION_DAYS.outboundFailed) } } }),
    (ids) => prisma.outboundSyncQueue.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.outboundSyncQueue.findMany({ where: { syncStatus: OutboundSyncStatus.FAILED, createdAt: { lt: cutoff(RETENTION_DAYS.outboundFailed) } }, select: { id: true }, take: BATCH }),
  )

  // ── AdMutation ─────────────────────────────────────────────────────────────
  const mutSettled = ['APPLIED', 'CANCELLED', 'SUPERSEDED']
  await sweep(
    'adMutation.settled',
    () => prisma.adMutation.count({ where: { state: { in: mutSettled }, createdAt: { lt: cutoff(RETENTION_DAYS.mutationSettled) } } }),
    (ids) => prisma.adMutation.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.adMutation.findMany({ where: { state: { in: mutSettled }, createdAt: { lt: cutoff(RETENTION_DAYS.mutationSettled) } }, select: { id: true }, take: BATCH }),
  )
  await sweep(
    'adMutation.failed',
    () => prisma.adMutation.count({ where: { state: 'FAILED', createdAt: { lt: cutoff(RETENTION_DAYS.mutationFailed) } } }),
    (ids) => prisma.adMutation.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.adMutation.findMany({ where: { state: 'FAILED', createdAt: { lt: cutoff(RETENTION_DAYS.mutationFailed) } }, select: { id: true }, take: BATCH }),
  )

  // ── The audit trail ────────────────────────────────────────────────────────
  await sweep(
    'campaignBidHistory',
    () => prisma.campaignBidHistory.count({ where: { changedAt: { lt: cutoff(RETENTION_DAYS.bidHistory) } } }),
    (ids) => prisma.campaignBidHistory.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.campaignBidHistory.findMany({ where: { changedAt: { lt: cutoff(RETENTION_DAYS.bidHistory) } }, select: { id: true }, take: BATCH }),
  )
  await sweep(
    'advertisingActionLog',
    // Never prune a row that has been rolled back but not yet settled — that pairing is the record
    // of a reversal, and losing half of it is worse than keeping both halves.
    () => prisma.advertisingActionLog.count({ where: { createdAt: { lt: cutoff(RETENTION_DAYS.actionLog) } } }),
    (ids) => prisma.advertisingActionLog.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.advertisingActionLog.findMany({ where: { createdAt: { lt: cutoff(RETENTION_DAYS.actionLog) } }, select: { id: true }, take: BATCH }),
  )

  // ── ADM-P6: sampled budget-usage readings ──────────────────────────────────
  await sweep(
    'adBudgetUsageSample',
    () => prisma.adBudgetUsageSample.count({ where: { lastSeenAt: { lt: cutoff(RETENTION_DAYS.budgetUsageSample) } } }),
    (ids) => prisma.adBudgetUsageSample.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.adBudgetUsageSample.findMany({ where: { lastSeenAt: { lt: cutoff(RETENTION_DAYS.budgetUsageSample) } }, select: { id: true }, take: BATCH }),
  )

  // ── Drift: resolved only ───────────────────────────────────────────────────
  await sweep(
    'adDrift.resolved',
    () => prisma.adDrift.count({ where: { resolvedAt: { not: null, lt: cutoff(RETENTION_DAYS.driftResolved) } } }),
    (ids) => prisma.adDrift.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
    () => prisma.adDrift.findMany({ where: { resolvedAt: { not: null, lt: cutoff(RETENTION_DAYS.driftResolved) } }, select: { id: true }, take: BATCH }),
  )

  const total = Object.values(deleted).reduce((a, b) => a + b, 0)
  logger.info('[ads-retention] sweep complete', { dryRun, total, deleted, cappedTables })
  return { dryRun, deleted, total, cappedTables }
}

export async function runAdsRetentionCron(): Promise<void> {
  try {
    await recordCronRun('ads-retention', async () => {
      const r = await runAdsRetentionOnce({ dryRun: false })
      return `pruned=${r.total}${r.cappedTables.length ? ` more-pending=${r.cappedTables.join(',')}` : ''}`
    })
  } catch (err) {
    logger.error('ads-retention cron failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false
export function startAdsRetentionCron(): void {
  if (task) return
  // OFF unless explicitly enabled. This job DELETES, so it opts in rather than out — the same
  // stance rank-defend takes for writing to Amazon.
  if (process.env.NEXUS_ENABLE_ADS_RETENTION !== '1') {
    logger.info('ads-retention cron disabled (set NEXUS_ENABLE_ADS_RETENTION=1)')
    return
  }
  // Daily, off-peak. Nothing here is time-sensitive: a row a day past its window is harmless.
  const schedule = process.env.NEXUS_ADS_RETENTION_SCHEDULE ?? '25 4 * * *'
  task = cron.schedule(schedule, () => {
    if (running) { logger.warn('[ads-retention] previous sweep still in flight — skipping'); return }
    running = true
    void runAdsRetentionCron().finally(() => { running = false })
  })
  logger.info(`ads-retention cron scheduled (${schedule})`)
}
