/**
 * SQP.2 — the COLLECT tick. The other half of the split that `sqp-ingest` no longer does itself.
 *
 * `sqp-ingest` creates the reports and returns in seconds. This picks them up whenever Amazon has
 * finished them, which measured 83 minutes to 13.7 hours after the request — because Amazon
 * generates this account's reports serially and the queue is our own burst
 * (docs/2026-08-12-sqp-feed.md §3).
 *
 * **Cadence is set by the retention window, not by impatience.** A collect tick that finds nothing
 * finished costs one `getReport` per outstanding id and nothing else, so hourly is cheap; running
 * more often buys nothing, because we cannot make Amazon's queue move.
 *
 * 🔴 Retention is NOT ~72h from the request. Measured 2026-08-12: documents 87.7h and 169h past their
 * request still downloaded. The clock runs from when Amazon created the DOCUMENT, which for a queued
 * report is hours after we asked. So this never concludes expiry from age — only from a 404.
 *
 * 🔴 It reports `stillPending` as a NORMAL outcome, not a failure. Most ticks will find most
 * requests unfinished — that is the queue, working as measured. The failure modes it does report are
 * `EXPIRED` (a 404: the document is genuinely gone), `FATAL`/`CANCELLED` (Amazon ended it) and
 * `ERROR` (our side), and they are deliberately different words: the old design's single
 * `failedAsins` counter is exactly what hid the fact that nothing had actually failed.
 */

import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runSqpCollectOnce(): Promise<string> {
  const { collectSqpReports, SQP_DOCUMENT_RETENTION_HOURS } = await import('../services/advertising/sqp-async.service.js')

  const before = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
  const outstandingBefore = before.filter((b) => b.status === 'PENDING' || b.status === 'DONE').reduce((a, b) => a + b._count._all, 0)
  if (outstandingBefore === 0) {
    // Nothing to do is not a failure and must not read as one. A request pass that never ran is a
    // different problem, visible on sqp-ingest's own row.
    return `nothing outstanding · states=${before.map((b) => `${b.status}=${b._count._all}`).join(',') || 'none'}`
  }

  const r = await collectSqpReports({ limit: Number(process.env.NEXUS_SQP_COLLECT_LIMIT) || 60, paceMs: 1_200 })

  // The oldest thing still waiting — the number that says how close we are to losing a document.
  const oldest = await prisma.sqpReportRequest.findFirst({
    where: { status: { in: ['PENDING', 'DONE'] } },
    orderBy: { requestedAt: 'asc' },
    select: { requestedAt: true, asin: true, marketplace: true },
  })
  const oldestH = oldest ? (Date.now() - +oldest.requestedAt) / 3_600_000 : 0
  const headroomH = oldest ? SQP_DOCUMENT_RETENTION_HOURS - oldestH : 0

  const summary =
    `polled=${r.polled} ingested=${r.ingested} rows=${r.rowsUpserted} parsed=${r.rowsParsed}` +
    ` · pending=${r.stillPending}` +
    (r.expired ? ` 🔴 expired=${r.expired}` : '') +
    (r.terminal ? ` terminal=${r.terminal}` : '') +
    (r.errors ? ` errors=${r.errors}` : '') +
    (r.pastRetentionStillTrying ? ` pastRetention=${r.pastRetentionStillTrying}(still polling — expiry is only ever a 404)` : '') +
    (r.collectionLagMsP50 != null ? ` · lag(done→ingest) p50=${(r.collectionLagMsP50 / 60_000).toFixed(1)}m` : '') +
    (oldest ? ` · oldest outstanding ${oldestH.toFixed(1)}h (${headroomH.toFixed(1)}h of retention left)` : '')

  // 🔴 An expiry is a real defect — a report generated and lost — so it fails the row rather than
  // hiding in a summary nobody reads. Anything still pending is NOT a failure.
  if (r.expired > 0) {
    throw new Error(`sqp-collect: ${r.expired} report document(s) EXPIRED un-collected — the collect cadence is losing data Amazon had finished. ${summary}`)
  }
  return summary
}

export async function runSqpCollectCron(): Promise<void> {
  try {
    await recordCronRun('sqp-collect', runSqpCollectOnce)
  } catch (err) {
    logger.error('sqp-collect cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startSqpCollectCron(): void {
  if (scheduledTask) {
    logger.warn('sqp-collect cron already started')
    return
  }
  if (envEnabled('NEXUS_DISABLE_SQP_COLLECT_CRON')) {
    logger.info('sqp-collect cron disabled (NEXUS_DISABLE_SQP_COLLECT_CRON=1)')
    return
  }
  // :20 past every hour — offset from the :00 report crons (returns, FBA planning) so a collect tick
  // does not queue its getReport calls behind their createReport burst on the same serial slot.
  const schedule = process.env.NEXUS_SQP_COLLECT_SCHEDULE ?? '20 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('sqp-collect cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => void runSqpCollectCron())
  logger.info(`sqp-collect cron scheduled (${schedule})`)
}
