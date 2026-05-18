/**
 * AD.1 — Cron wrappers for the Trading Desk substrate jobs.
 *
 *   ads-sync                 every 30 min — pulls campaign structure
 *   fba-storage-age-ingest   every 6 hours — refreshes aged-stock feed
 *   true-profit-rollup       nightly 03:00 UTC — re-aggregates yesterday
 *   ads-metrics-ingest       hourly :22 — legacy metrics path
 *
 * Phase 11 — Reports API pipeline crons (all gated by same env flag):
 *   ads-report-create        daily 01:15 UTC — creates yesterday's reports
 *   ads-report-create-st     daily 01:30 UTC — creates search-term reports
 *   ads-report-create-pl     daily 01:45 UTC — creates placement reports
 *   ads-report-poll          every 10 min — advances PENDING → COMPLETED
 *   ads-report-ingest        every 15 min :07 — downloads + writes rows
 *   ads-search-term-cleanup  weekly Sunday 04:00 UTC — prunes old rows
 *
 * H.2d — Amazon Ads API v1 unified export pipeline (parallel to ads-sync
 * until H.2e cuts that over):
 *   ads-v1-export-create     every 6h — exports 4 resources per profile
 *   ads-v1-export-poll       every 5 min — advances PENDING → COMPLETED
 *   ads-v1-export-ingest     every 5 min :02,:07,... — downloads + upsert
 *
 * All jobs are gated by `NEXUS_ENABLE_AMAZON_ADS_CRON=1` and default
 * off in dev. Sandbox mode writes to DB but skips live Amazon calls.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import {
  runAdsSyncOnce as runAdsSyncCore,
  summarizeAdsSync,
} from '../services/advertising/ads-sync.service.js'
import {
  runFbaStorageAgeIngestOnce as runFbaStorageAgeIngestCore,
  summarizeFbaStorageAge,
} from '../services/advertising/fba-storage-age-ingest.service.js'
import {
  runTrueProfitRollupOnce as runTrueProfitRollupCore,
  summarizeTrueProfitRollup,
} from '../services/advertising/true-profit-rollup.service.js'
import {
  runAdsMetricsIngestOnce as runAdsMetricsIngestCore,
  summarizeAdsMetricsIngest,
} from '../services/advertising/ads-metrics-ingest.service.js'
import {
  runReportCreationCycle,
  runSearchTermReportCycle,
  runPlacementReportCycle,
  pollPendingJobs,
  ingestCompletedJob,
  cleanupOldSearchTerms,
} from '../services/advertising/ads-reports.service.js'
import {
  runFbaFeesIngest,
  summarizeFbaFeesIngest,
} from '../services/advertising/fba-fees-ingest.service.js'
import {
  runV1ExportCycle,
  pollPendingExports,
  ingestCompletedExport,
  summarizeCycle as summarizeV1Cycle,
} from '../services/advertising/ads-v1-sync.service.js'
import prisma from '../db.js'

let adsSyncTask: ReturnType<typeof cron.schedule> | null = null
let fbaStorageAgeTask: ReturnType<typeof cron.schedule> | null = null
let trueProfitRollupTask: ReturnType<typeof cron.schedule> | null = null
let adsMetricsIngestTask: ReturnType<typeof cron.schedule> | null = null
let fbaFeesIngestTask: ReturnType<typeof cron.schedule> | null = null
let reportCreateTask: ReturnType<typeof cron.schedule> | null = null
let reportCreateStTask: ReturnType<typeof cron.schedule> | null = null
let reportCreatePlTask: ReturnType<typeof cron.schedule> | null = null
let reportPollTask: ReturnType<typeof cron.schedule> | null = null
let reportIngestTask: ReturnType<typeof cron.schedule> | null = null
let searchTermCleanupTask: ReturnType<typeof cron.schedule> | null = null
let v1ExportCreateTask: ReturnType<typeof cron.schedule> | null = null
let v1ExportPollTask: ReturnType<typeof cron.schedule> | null = null
let v1ExportIngestTask: ReturnType<typeof cron.schedule> | null = null

// ── ads-sync ──────────────────────────────────────────────────────────

export async function runAdsSyncCron(): Promise<void> {
  try {
    await recordCronRun('ads-sync', async () => {
      const s = await runAdsSyncCore()
      const summary = summarizeAdsSync(s)
      logger.info('ads-sync cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('ads-sync cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAdsSyncCron(): void {
  if (adsSyncTask) {
    logger.warn('ads-sync cron already started')
    return
  }
  const schedule = process.env.NEXUS_ADS_SYNC_SCHEDULE ?? '*/30 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('ads-sync cron: invalid schedule', { schedule })
    return
  }
  adsSyncTask = cron.schedule(schedule, () => {
    void runAdsSyncCron()
  })
  logger.info('ads-sync cron: scheduled', { schedule })
}

// ── fba-storage-age-ingest ────────────────────────────────────────────

export async function runFbaStorageAgeIngestCron(): Promise<void> {
  try {
    await recordCronRun('fba-storage-age-ingest', async () => {
      const s = await runFbaStorageAgeIngestCore()
      const summary = summarizeFbaStorageAge(s)
      logger.info('fba-storage-age-ingest cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('fba-storage-age-ingest cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startFbaStorageAgeIngestCron(): void {
  if (fbaStorageAgeTask) {
    logger.warn('fba-storage-age-ingest cron already started')
    return
  }
  // Every 6 hours at minute 7 (offset from sales-report-ingest at 02:00
  // and other on-the-hour jobs so we don't pile load on the same tick).
  const schedule = process.env.NEXUS_FBA_STORAGE_AGE_SCHEDULE ?? '7 */6 * * *'
  if (!cron.validate(schedule)) {
    logger.error('fba-storage-age-ingest cron: invalid schedule', { schedule })
    return
  }
  fbaStorageAgeTask = cron.schedule(schedule, () => {
    void runFbaStorageAgeIngestCron()
  })
  logger.info('fba-storage-age-ingest cron: scheduled', { schedule })
}

// ── true-profit-rollup ────────────────────────────────────────────────

export async function runTrueProfitRollupCron(): Promise<void> {
  try {
    await recordCronRun('true-profit-rollup', async () => {
      const s = await runTrueProfitRollupCore()
      const summary = summarizeTrueProfitRollup(s)
      logger.info('true-profit-rollup cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('true-profit-rollup cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startTrueProfitRollupCron(): void {
  if (trueProfitRollupTask) {
    logger.warn('true-profit-rollup cron already started')
    return
  }
  // Nightly 03:00 UTC — runs after sales-report-ingest at 02:00 so the
  // OrderItem data for "yesterday" is fully ingested by the time we
  // aggregate it.
  const schedule = process.env.NEXUS_TRUE_PROFIT_ROLLUP_SCHEDULE ?? '0 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('true-profit-rollup cron: invalid schedule', { schedule })
    return
  }
  trueProfitRollupTask = cron.schedule(schedule, () => {
    void runTrueProfitRollupCron()
  })
  logger.info('true-profit-rollup cron: scheduled', { schedule })
}

// ── ads-metrics-ingest (AD.2) ─────────────────────────────────────────

export async function runAdsMetricsIngestCron(): Promise<void> {
  try {
    await recordCronRun('ads-metrics-ingest', async () => {
      const s = await runAdsMetricsIngestCore()
      const summary = summarizeAdsMetricsIngest(s)
      logger.info('ads-metrics-ingest cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('ads-metrics-ingest cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAdsMetricsIngestCron(): void {
  if (adsMetricsIngestTask) {
    logger.warn('ads-metrics-ingest cron already started')
    return
  }
  // Hourly at minute 22 — staggered off top-of-hour jobs. Reports take
  // 30-90s to materialize on Amazon's side; hourly keeps freshness
  // without thrashing the Reports API.
  const schedule = process.env.NEXUS_ADS_METRICS_SCHEDULE ?? '22 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('ads-metrics-ingest cron: invalid schedule', { schedule })
    return
  }
  adsMetricsIngestTask = cron.schedule(schedule, () => {
    void runAdsMetricsIngestCron()
  })
  logger.info('ads-metrics-ingest cron: scheduled', { schedule })
}

// ── AD.4 Step 6: FBA fees ingest cron ────────────────────────────────
// Sunday 02:00 UTC weekly — fee estimates change slowly (size-tier
// reclassifications happen at most monthly). Staggered 2h before the
// search-term cleanup at 04:00 so both don't fire simultaneously.

export async function runFbaFeesIngestCron(): Promise<void> {
  await recordCronRun('fba-fees-ingest', async () => {
    const r = await runFbaFeesIngest({ rollupWindowDays: 30 })
    return summarizeFbaFeesIngest(r)
  }).catch((err) => logger.error('fba-fees-ingest cron: failure', { error: String(err) }))
}

export function startFbaFeesIngestCron(): void {
  if (fbaFeesIngestTask) { logger.warn('fba-fees-ingest already started'); return }
  const schedule = process.env.NEXUS_FBA_FEES_SCHEDULE ?? '0 2 * * 0'
  if (!cron.validate(schedule)) { logger.error('fba-fees-ingest: invalid schedule', { schedule }); return }
  fbaFeesIngestTask = cron.schedule(schedule, () => { void runFbaFeesIngestCron() })
  logger.info('fba-fees-ingest cron: scheduled', { schedule })
}

// ── Phase 11: Reports API pipeline crons ─────────────────────────────
//
// Three creation crons (staggered 15 min apart) and two processing crons.
// Yesterday's date is computed at runtime so no date is baked into the
// schedule — safe across midnight rollovers.

function yesterday(): { startDate: string; endDate: string } {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  const iso = d.toISOString().slice(0, 10)
  return { startDate: iso, endDate: iso }
}

// 01:15 UTC daily — campaign-level performance reports
export async function runReportCreateCron(): Promise<void> {
  await recordCronRun('ads-report-create', async () => {
    const { startDate, endDate } = yesterday()
    const result = await runReportCreationCycle({ startDate, endDate })
    return `created=${result.jobsCreated} skipped=${result.jobsSkipped} errors=${result.errors.length}`
  }).catch((err) => logger.error('ads-report-create cron: failure', { error: String(err) }))
}

export function startReportCreateCron(): void {
  if (reportCreateTask) { logger.warn('ads-report-create already started'); return }
  const schedule = process.env.NEXUS_ADS_REPORT_CREATE_SCHEDULE ?? '15 1 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-report-create: invalid schedule', { schedule }); return }
  reportCreateTask = cron.schedule(schedule, () => { void runReportCreateCron() })
  logger.info('ads-report-create cron: scheduled', { schedule })
}

// 01:30 UTC daily — search-term reports (SP + SB)
export async function runReportCreateStCron(): Promise<void> {
  await recordCronRun('ads-report-create-st', async () => {
    const { startDate, endDate } = yesterday()
    const result = await runSearchTermReportCycle({ startDate, endDate })
    return `created=${result.jobsCreated} skipped=${result.jobsSkipped} errors=${result.errors.length}`
  }).catch((err) => logger.error('ads-report-create-st cron: failure', { error: String(err) }))
}

export function startReportCreateStCron(): void {
  if (reportCreateStTask) { logger.warn('ads-report-create-st already started'); return }
  const schedule = process.env.NEXUS_ADS_REPORT_CREATE_ST_SCHEDULE ?? '30 1 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-report-create-st: invalid schedule', { schedule }); return }
  reportCreateStTask = cron.schedule(schedule, () => { void runReportCreateStCron() })
  logger.info('ads-report-create-st cron: scheduled', { schedule })
}

// 01:45 UTC daily — placement reports (SP only)
export async function runReportCreatePlCron(): Promise<void> {
  await recordCronRun('ads-report-create-pl', async () => {
    const { startDate, endDate } = yesterday()
    const result = await runPlacementReportCycle({ startDate, endDate })
    return `created=${result.jobsCreated} skipped=${result.jobsSkipped} errors=${result.errors.length}`
  }).catch((err) => logger.error('ads-report-create-pl cron: failure', { error: String(err) }))
}

export function startReportCreatePlCron(): void {
  if (reportCreatePlTask) { logger.warn('ads-report-create-pl already started'); return }
  const schedule = process.env.NEXUS_ADS_REPORT_CREATE_PL_SCHEDULE ?? '45 1 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-report-create-pl: invalid schedule', { schedule }); return }
  reportCreatePlTask = cron.schedule(schedule, () => { void runReportCreatePlCron() })
  logger.info('ads-report-create-pl cron: scheduled', { schedule })
}

// Every 10 min — poll PENDING/IN_PROGRESS jobs → advance status
export async function runReportPollCron(): Promise<void> {
  await recordCronRun('ads-report-poll', async () => {
    const summary = await pollPendingJobs(30)
    return `polled=${summary.polled} completed=${summary.completed} failed=${summary.failed}`
  }).catch((err) => logger.error('ads-report-poll cron: failure', { error: String(err) }))
}

export function startReportPollCron(): void {
  if (reportPollTask) { logger.warn('ads-report-poll already started'); return }
  const schedule = process.env.NEXUS_ADS_REPORT_POLL_SCHEDULE ?? '*/10 * * * *'
  if (!cron.validate(schedule)) { logger.error('ads-report-poll: invalid schedule', { schedule }); return }
  reportPollTask = cron.schedule(schedule, () => { void runReportPollCron() })
  logger.info('ads-report-poll cron: scheduled', { schedule })
}

// Every 15 min at :07 — ingest COMPLETED jobs (download S3 + write rows)
export async function runReportIngestCron(): Promise<void> {
  await recordCronRun('ads-report-ingest', async () => {
    const jobs = await prisma.amazonAdsReportJob.findMany({
      where: { status: 'COMPLETED', location: { not: null } },
      select: { id: true },
      orderBy: { completedAt: 'asc' },
      take: 10,
    })
    let ingested = 0; let errors = 0
    for (const job of jobs) {
      try { await ingestCompletedJob(job.id); ingested++ }
      catch (err) { errors++; logger.error('report ingest error', { jobId: job.id, error: String(err) }) }
    }
    return `ingested=${ingested} errors=${errors}`
  }).catch((err) => logger.error('ads-report-ingest cron: failure', { error: String(err) }))
}

export function startReportIngestCron(): void {
  if (reportIngestTask) { logger.warn('ads-report-ingest already started'); return }
  const schedule = process.env.NEXUS_ADS_REPORT_INGEST_SCHEDULE ?? '7,22,37,52 * * * *'
  if (!cron.validate(schedule)) { logger.error('ads-report-ingest: invalid schedule', { schedule }); return }
  reportIngestTask = cron.schedule(schedule, () => { void runReportIngestCron() })
  logger.info('ads-report-ingest cron: scheduled', { schedule })
}

// Weekly Sunday 04:00 UTC — prune search-term rows older than 90 days
export async function runSearchTermCleanupCron(): Promise<void> {
  await recordCronRun('ads-search-term-cleanup', async () => {
    const result = await cleanupOldSearchTerms(90)
    return `deleted=${result.deletedSearchTerms} cutoff=${result.cutoffDate}`
  }).catch((err) => logger.error('ads-search-term-cleanup cron: failure', { error: String(err) }))
}

export function startSearchTermCleanupCron(): void {
  if (searchTermCleanupTask) { logger.warn('ads-search-term-cleanup already started'); return }
  const schedule = process.env.NEXUS_ADS_SEARCH_TERM_CLEANUP_SCHEDULE ?? '0 4 * * 0'
  if (!cron.validate(schedule)) { logger.error('ads-search-term-cleanup: invalid schedule', { schedule }); return }
  searchTermCleanupTask = cron.schedule(schedule, () => { void runSearchTermCleanupCron() })
  logger.info('ads-search-term-cleanup cron: scheduled', { schedule })
}

// ── H.2d: Amazon Ads API v1 unified export crons ────────────────────
// Three crons that together replace Phase B's per-product /sp/ /sb/v4/
// /sd/ list-call pattern with the v1 unified export flow. Run in
// parallel to ads-sync (Phase B path) until H.2e cuts that over —
// both pipelines populate the same Campaign/AdGroup/AdTarget/AdProductAd
// tables, last writer wins on upsert (same upsert key).

// Every 6h — full create cycle (4 resources × N profiles)
export async function runV1ExportCreateCron(): Promise<void> {
  await recordCronRun('ads-v1-export-create', async () => {
    const result = await runV1ExportCycle({})
    return summarizeV1Cycle(result)
  }).catch((err) => logger.error('ads-v1-export-create cron: failure', { error: String(err) }))
}

export function startV1ExportCreateCron(): void {
  if (v1ExportCreateTask) { logger.warn('ads-v1-export-create already started'); return }
  const schedule = process.env.NEXUS_ADS_V1_EXPORT_CREATE_SCHEDULE ?? '0 */6 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-v1-export-create: invalid schedule', { schedule }); return }
  v1ExportCreateTask = cron.schedule(schedule, () => { void runV1ExportCreateCron() })
  logger.info('ads-v1-export-create cron: scheduled', { schedule })
}

// Every 5 min — advance PENDING/IN_PROGRESS jobs by polling Amazon's
// /exports/{id} endpoint. v1 exports complete in ~10-30s typically, so
// 5-min cadence catches them within at most one full cycle.
export async function runV1ExportPollCron(): Promise<void> {
  await recordCronRun('ads-v1-export-poll', async () => {
    const s = await pollPendingExports(30)
    return `polled=${s.polled} completed=${s.completed} failed=${s.failed} stillPending=${s.stillPending}`
  }).catch((err) => logger.error('ads-v1-export-poll cron: failure', { error: String(err) }))
}

export function startV1ExportPollCron(): void {
  if (v1ExportPollTask) { logger.warn('ads-v1-export-poll already started'); return }
  const schedule = process.env.NEXUS_ADS_V1_EXPORT_POLL_SCHEDULE ?? '*/5 * * * *'
  if (!cron.validate(schedule)) { logger.error('ads-v1-export-poll: invalid schedule', { schedule }); return }
  v1ExportPollTask = cron.schedule(schedule, () => { void runV1ExportPollCron() })
  logger.info('ads-v1-export-poll cron: scheduled', { schedule })
}

// Every 5 min staggered at :02,:07,:12,...,:57 — process up to 10
// COMPLETED jobs per tick (download + decompress + upsert). Stagger
// off the poll cron so the two don't contend on the same minute.
// 1-hour S3 URL TTL means we have plenty of headroom.
export async function runV1ExportIngestCron(): Promise<void> {
  await recordCronRun('ads-v1-export-ingest', async () => {
    const jobs = await prisma.amazonAdsExportJob.findMany({
      where: { status: 'COMPLETED', url: { not: null } },
      select: { id: true },
      orderBy: { completedAt: 'asc' },
      take: 10,
    })
    let ingested = 0; let totalRows = 0; let errors = 0
    for (const job of jobs) {
      try {
        const r = await ingestCompletedExport(job.id)
        ingested += 1
        totalRows += r.rowsIngested
        if (r.error) errors += 1
      } catch (err) {
        errors += 1
        logger.error('v1 export ingest error', { jobId: job.id, error: String(err) })
      }
    }
    return `ingested=${ingested} rows=${totalRows} errors=${errors}`
  }).catch((err) => logger.error('ads-v1-export-ingest cron: failure', { error: String(err) }))
}

export function startV1ExportIngestCron(): void {
  if (v1ExportIngestTask) { logger.warn('ads-v1-export-ingest already started'); return }
  const schedule = process.env.NEXUS_ADS_V1_EXPORT_INGEST_SCHEDULE ?? '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'
  if (!cron.validate(schedule)) { logger.error('ads-v1-export-ingest: invalid schedule', { schedule }); return }
  v1ExportIngestTask = cron.schedule(schedule, () => { void runV1ExportIngestCron() })
  logger.info('ads-v1-export-ingest cron: scheduled', { schedule })
}

// ── Bulk start (called from index.ts when NEXUS_ENABLE_AMAZON_ADS_CRON=1) ──

export function startAllAdvertisingCrons(): void {
  startAdsSyncCron()
  startFbaStorageAgeIngestCron()
  startTrueProfitRollupCron()
  // Phase B follow-up: legacy ads-metrics-ingest retired. It synchronously
  // polled /reporting/reports for up to 10 min per profile and hard-coded
  // adProduct=SPONSORED_PRODUCTS, generating one error per profile per
  // hour. The async Phase 11 pipeline (ads-report-create + poll +
  // ingest) below replaces it 100%, supports all ad products, and runs
  // on the recommended async cadence. Service code retained for ad-hoc
  // manual invocation; cron registration removed.
  // startAdsMetricsIngestCron()  // ← retired
  // AD.4 Step 6: FBA fees
  startFbaFeesIngestCron()
  // Phase 11: Reports API pipeline
  startReportCreateCron()
  startReportCreateStCron()
  startReportCreatePlCron()
  startReportPollCron()
  startReportIngestCron()
  startSearchTermCleanupCron()
  // H.2d: v1 unified export pipeline (parallel to ads-sync until H.2e)
  startV1ExportCreateCron()
  startV1ExportPollCron()
  startV1ExportIngestCron()
}

export function stopAllAdvertisingCrons(): void {
  if (adsSyncTask) {
    adsSyncTask.stop()
    adsSyncTask = null
  }
  if (fbaStorageAgeTask) {
    fbaStorageAgeTask.stop()
    fbaStorageAgeTask = null
  }
  if (trueProfitRollupTask) {
    trueProfitRollupTask.stop()
    trueProfitRollupTask = null
  }
  if (adsMetricsIngestTask) {
    adsMetricsIngestTask.stop()
    adsMetricsIngestTask = null
  }
  if (fbaFeesIngestTask) { fbaFeesIngestTask.stop(); fbaFeesIngestTask = null }
  for (const [key, task] of [
    ['reportCreateTask',    reportCreateTask]    as const,
    ['reportCreateStTask',  reportCreateStTask]  as const,
    ['reportCreatePlTask',  reportCreatePlTask]  as const,
    ['reportPollTask',      reportPollTask]      as const,
    ['reportIngestTask',    reportIngestTask]    as const,
    ['searchTermCleanupTask', searchTermCleanupTask] as const,
    ['v1ExportCreateTask',  v1ExportCreateTask]  as const,
    ['v1ExportPollTask',    v1ExportPollTask]    as const,
    ['v1ExportIngestTask',  v1ExportIngestTask]  as const,
  ]) {
    if (task) { task.stop(); logger.debug(`${key} stopped`) }
  }
  reportCreateTask = null; reportCreateStTask = null; reportCreatePlTask = null
  reportPollTask = null; reportIngestTask = null; searchTermCleanupTask = null
  v1ExportCreateTask = null; v1ExportPollTask = null; v1ExportIngestTask = null
}
