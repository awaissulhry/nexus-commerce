/**
 * Cron wrappers for the Trading Desk substrate jobs (post-H.2e).
 *
 *   fba-storage-age-ingest   every 6h — refreshes aged-stock feed
 *   true-profit-rollup       nightly 03:00 UTC — re-aggregates yesterday
 *   fba-fees-ingest          weekly Sun 02:00 UTC — SP-API fees feed
 *
 * Reports API pipeline (performance data):
 *   ads-report-create        daily 01:15 UTC — creates yesterday's reports
 *   ads-report-create-st     daily 01:30 UTC — creates search-term reports
 *   ads-report-create-pl     daily 01:45 UTC — creates placement reports
 *   ads-report-poll          every 10 min — advances PENDING → COMPLETED
 *   ads-report-ingest        every 15 min :07 — downloads + writes rows
 *   ads-search-term-cleanup  weekly Sun 04:00 UTC — prunes old rows
 *
 * Amazon Ads API v1 unified export pipeline (structure data):
 *   ads-v1-export-create     every 6h — exports 4 resources × N profiles
 *   ads-v1-export-poll       every 5 min — advances PENDING → COMPLETED
 *   ads-v1-export-ingest     every 5 min :02,:07,... — downloads + upsert
 *
 * Retired in H.2e (2026-05-18): ads-sync (Phase B per-product structure
 * sync, replaced by v1 export pipeline above). Retired earlier:
 * ads-metrics-ingest (legacy synchronous reports, replaced by Phase 11
 * async pipeline).
 *
 * All jobs gated by NEXUS_ENABLE_AMAZON_ADS_CRON=1; default off in dev.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
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
  runAdvertisedProductReportCycle,
  pollPendingJobs,
  ingestCompletedJob,
  cleanupOldSearchTerms,
  cleanupOldHourlyPerformance,
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
import { syncCampaignSettingsFromAmazon } from '../services/advertising/ads-campaign-settings-sync.service.js'
import prisma from '../db.js'

let fbaStorageAgeTask: ReturnType<typeof cron.schedule> | null = null
let trueProfitRollupTask: ReturnType<typeof cron.schedule> | null = null
let adsMetricsIngestTask: ReturnType<typeof cron.schedule> | null = null
let adsReconcileTask: ReturnType<typeof cron.schedule> | null = null
let fbaFeesIngestTask: ReturnType<typeof cron.schedule> | null = null
let reportCreateTask: ReturnType<typeof cron.schedule> | null = null
let reportCreateStTask: ReturnType<typeof cron.schedule> | null = null
let reportCreatePlTask: ReturnType<typeof cron.schedule> | null = null
let reportCreateApTask: ReturnType<typeof cron.schedule> | null = null
let reportPollTask: ReturnType<typeof cron.schedule> | null = null
let reportIngestTask: ReturnType<typeof cron.schedule> | null = null
let searchTermCleanupTask: ReturnType<typeof cron.schedule> | null = null
let v1ExportCreateTask: ReturnType<typeof cron.schedule> | null = null
let v1ExportPollTask: ReturnType<typeof cron.schedule> | null = null
let v1ExportIngestTask: ReturnType<typeof cron.schedule> | null = null
let keywordBidResyncTask: ReturnType<typeof cron.schedule> | null = null
let anomalyGuardTask: ReturnType<typeof cron.schedule> | null = null
let autoBidTask: ReturnType<typeof cron.schedule> | null = null
let autoHarvestTask: ReturnType<typeof cron.schedule> | null = null
let campaignSettingsSyncTask: ReturnType<typeof cron.schedule> | null = null

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

// ── ads-metrics-reconcile (AME.4) ─────────────────────────────────────
// Nightly self-heal: recompute the stale stored Campaign.spend columns from
// the daily-performance table + log account-vs-attributed variance and stale
// marketplaces. Runs after the report ingest so the daily rows are fresh.

export async function runAdsReconcileCron(): Promise<void> {
  try {
    await recordCronRun('ads-metrics-reconcile', async () => {
      const { reconcileAdMetrics } = await import('../services/advertising/ads-reconcile.service.js')
      const r = await reconcileAdMetrics({ windowDays: 30, heal: true })
      const summary = `healed=${r.campaignsHealed} driftBefore=€${(r.storedSpendDriftCentsBefore / 100).toFixed(2)} account=€${(r.accountSpendCents / 100).toFixed(2)} variance=${r.variancePct ?? '—'}% through=${r.dataThrough ?? '—'} stale=${r.staleMarketplaces.length}`
      if (r.staleMarketplaces.length > 0) logger.warn('ads-metrics-reconcile: stale marketplaces', { stale: r.staleMarketplaces })
      logger.info('ads-metrics-reconcile cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('ads-metrics-reconcile cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startAdsReconcileCron(): void {
  if (adsReconcileTask) {
    logger.warn('ads-metrics-reconcile cron already started')
    return
  }
  const schedule = process.env.NEXUS_ADS_RECONCILE_SCHEDULE ?? '30 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('ads-metrics-reconcile cron: invalid schedule', { schedule })
    return
  }
  adsReconcileTask = cron.schedule(schedule, () => {
    void runAdsReconcileCron()
  })
  logger.info('ads-metrics-reconcile cron: scheduled', { schedule })
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

// ── B — live campaign-settings sync (placement bids / budget / strategy / state) ──
// Pulls each campaign's CURRENT settings from Amazon v3 every ~20 min so the cockpit
// reflects Amazon far fresher than the 6h v1 export (which carries NO placement bids).
// Read-only from Amazon + non-destructive DB writes.
export async function runCampaignSettingsSyncCron(): Promise<void> {
  try {
    await recordCronRun('ads-campaign-settings-sync', async () => {
      const r = await syncCampaignSettingsFromAmazon()
      return `profiles=${r.profiles} campaigns=${r.campaigns} updated=${r.updated} placements=${r.placementsFilled} errors=${r.errors.length}`
    })
  } catch (err) {
    logger.error('ads-campaign-settings-sync cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startCampaignSettingsSyncCron(): void {
  if (campaignSettingsSyncTask) { logger.warn('ads-campaign-settings-sync cron already started'); return }
  const schedule = process.env.NEXUS_ADS_SETTINGS_SYNC_SCHEDULE ?? '*/20 * * * *'
  if (!cron.validate(schedule)) { logger.error('ads-campaign-settings-sync cron: invalid schedule', { schedule }); return }
  campaignSettingsSyncTask = cron.schedule(schedule, () => { void runCampaignSettingsSyncCron() })
  logger.info('ads-campaign-settings-sync cron: scheduled', { schedule })
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

// 01:50 UTC daily — advertised-product reports (SP only) — PC.0
export async function runReportCreateApCron(): Promise<void> {
  await recordCronRun('ads-report-create-ap', async () => {
    const { startDate, endDate } = yesterday()
    const result = await runAdvertisedProductReportCycle({ startDate, endDate })
    return `created=${result.jobsCreated} skipped=${result.jobsSkipped} errors=${result.errors.length}`
  }).catch((err) => logger.error('ads-report-create-ap cron: failure', { error: String(err) }))
}

export function startReportCreateApCron(): void {
  if (reportCreateApTask) { logger.warn('ads-report-create-ap already started'); return }
  const schedule = process.env.NEXUS_ADS_REPORT_CREATE_AP_SCHEDULE ?? '50 1 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-report-create-ap: invalid schedule', { schedule }); return }
  reportCreateApTask = cron.schedule(schedule, () => { void runReportCreateApCron() })
  logger.info('ads-report-create-ap cron: scheduled', { schedule })
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
    // Same filter pattern as v1 exports: skip already-ingested AND
    // skip jobs whose signed URL has likely expired. Reports API has
    // no urlExpiresAt column; use completedAt > now-50min as proxy
    // (Amazon's S3 URLs have a 1-hour TTL — 50min gives safety margin).
    const fiftyMinAgo = new Date(Date.now() - 50 * 60 * 1000)
    const jobs = await prisma.amazonAdsReportJob.findMany({
      where: {
        status: 'COMPLETED',
        location: { not: null },
        rowsIngested: 0,
        completedAt: { gt: fiftyMinAgo },
      },
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
    const hourly = await cleanupOldHourlyPerformance(90)
    return `searchTerms=${result.deletedSearchTerms} hourly=${hourly.deletedHourlyRows} cutoff=${result.cutoffDate}`
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
  // H.10 — every 2h (was 6h) to halve the structure-freshness lag for campaigns/ad-groups created on
  // Amazon. Env-overridable. (Amazon offers no usable real-time push for ad structure, so frequent
  // polling is the lever; the v3 keyword/negative resync above runs hourly for the higher-churn surface.)
  const schedule = process.env.NEXUS_ADS_V1_EXPORT_CREATE_SCHEDULE ?? '0 */2 * * *'
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
      // H.2 follow-up: only pick jobs that haven't been ingested AND
      // whose signed S3 URL is still valid. Without this:
      //  - rowsIngested > 0 jobs get re-downloaded each cron tick
      //    (Amazon's presigned URLs aren't reliably re-usable across
      //     multiple GETs even within TTL → spurious s3_download_400)
      //  - expired-URL jobs with 0 legitimate rows get retried forever
      where: {
        status: 'COMPLETED',
        url: { not: null },
        rowsIngested: 0,
        // AF.1 — skip empty exports (fileSize ~22 = []), which otherwise keep
        // rowsIngested=0 forever and starve the data-rich jobs out of the take.
        fileSize: { gte: 100 },
        OR: [
          { urlExpiresAt: null }, // legacy rows missing expiry
          { urlExpiresAt: { gt: new Date() } },
        ],
      },
      select: { id: true },
      // AF.1 — newest first so fresh presigned URLs ingest before expiring.
      orderBy: { completedAt: 'desc' },
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

// AF.7 — keyword/target bid resync. The v1 export ingest above re-writes targets
// with a €0 bid (the export's bid is nested → coerced to 0); this pulls the REAL
// bids from the v3 list APIs (/sp/keywords + /sp/targets) so bids stay accurate
// after every structural sync, not just on the one-time manual backfill.
export async function runKeywordBidResyncCron(): Promise<void> {
  await recordCronRun('ads-keyword-bid-resync', async () => {
    const { resyncAllCampaignKeywords } = await import('../services/advertising/ads-keyword-list-sync.service.js')
    const r = await resyncAllCampaignKeywords({})
    return `profiles=${r.profiles} adGroups=${r.adGroups} kwUpserted=${r.upserted} targetsUpdated=${r.targetsUpdated} campNeg=${r.campaignNegatives} archived=${r.archived} mode=${r.mode}`
  }).catch((err) => logger.error('ads-keyword-bid-resync cron: failure', { error: String(err) }))
}

export function startKeywordBidResyncCron(): void {
  if (keywordBidResyncTask) { logger.warn('ads-keyword-bid-resync already started'); return }
  // H.10 — hourly at :45. Beyond bids, this v3 resync now also carries the campaign-negative mirror
  // (H.8) and deletion reconciliation (H.9) — the freshness-critical inbound path — so it runs hourly
  // to keep the local platform close to Amazon. Env-overridable if the account ever hits rate limits.
  const schedule = process.env.NEXUS_ADS_KEYWORD_BID_RESYNC_SCHEDULE ?? '45 * * * *'
  if (!cron.validate(schedule)) { logger.error('ads-keyword-bid-resync: invalid schedule', { schedule }); return }
  keywordBidResyncTask = cron.schedule(schedule, () => { void runKeywordBidResyncCron() })
  logger.info('ads-keyword-bid-resync cron: scheduled', { schedule })
}

// TD.0 — anomaly circuit-breaker. Every 10 min: if automation actions/hour or
// account ad-spend/hour spike past thresholds, trip a global halt + notify. The
// safety net above the per-rule caps.
export async function runAnomalyGuardCron(): Promise<void> {
  await recordCronRun('ads-anomaly-guard', async () => {
    const { runAnomalyGuardOnce } = await import('../services/advertising/ads-anomaly-guard.service.js')
    const r = await runAnomalyGuardOnce()
    return `tripped=${r.tripped} actions/h=${r.actionsLastHour} spend/h=${r.spendLastHourCents}c${r.reason ? ' reason=' + r.reason : ''}`
  }).catch((err) => logger.error('ads-anomaly-guard cron: failure', { error: String(err) }))
}

export function startAnomalyGuardCron(): void {
  if (anomalyGuardTask) { logger.warn('ads-anomaly-guard already started'); return }
  const schedule = process.env.NEXUS_ADS_ANOMALY_GUARD_SCHEDULE ?? '*/10 * * * *'
  if (!cron.validate(schedule)) { logger.error('ads-anomaly-guard: invalid schedule', { schedule }); return }
  anomalyGuardTask = cron.schedule(schedule, () => { void runAnomalyGuardCron() })
  logger.info('ads-anomaly-guard cron: scheduled', { schedule })
}

// TD.1 — automatic profit-native target-ACOS bidding. Every 6h: optimize bids
// toward each ad group's profit-derived target ACOS. Autonomy-gated (OFF/halt
// skip, SUGGEST propose-only) + per-campaign write-gate allowlist downstream.
export async function runAutoBidCron(): Promise<void> {
  await recordCronRun('ads-auto-bid', async () => {
    const { runAutoBidOnce } = await import('../services/advertising/ads-auto-bid.service.js')
    const r = await runAutoBidOnce()
    return r.skipped ? `skipped=${r.skipped}` : `proposed=${r.proposed} applied=${r.applied} dryRun=${r.dryRun}`
  }).catch((err) => logger.error('ads-auto-bid cron: failure', { error: String(err) }))
}

export function startAutoBidCron(): void {
  if (autoBidTask) { logger.warn('ads-auto-bid already started'); return }
  const schedule = process.env.NEXUS_ADS_AUTO_BID_SCHEDULE ?? '20 */6 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-auto-bid: invalid schedule', { schedule }); return }
  autoBidTask = cron.schedule(schedule, () => { void runAutoBidCron() })
  logger.info('ads-auto-bid cron: scheduled', { schedule })
}

// TD.2 — automatic keyword harvest + prune. Daily (search-term reports are T+1):
// promote converters to exact, auto-negative wasteful terms. Autonomy-gated.
export async function runAutoHarvestCron(): Promise<void> {
  await recordCronRun('ads-auto-harvest', async () => {
    const { runAutoHarvestOnce } = await import('../services/advertising/ads-auto-harvest.service.js')
    const r = await runAutoHarvestOnce()
    return r.skipped ? `skipped=${r.skipped}` : `neg=${r.negativesAdded}/${r.proposedNegatives} grad=${r.keywordsGraduated}/${r.proposedGraduations} dryRun=${r.dryRun}`
  }).catch((err) => logger.error('ads-auto-harvest cron: failure', { error: String(err) }))
}

export function startAutoHarvestCron(): void {
  if (autoHarvestTask) { logger.warn('ads-auto-harvest already started'); return }
  const schedule = process.env.NEXUS_ADS_AUTO_HARVEST_SCHEDULE ?? '30 6 * * *'
  if (!cron.validate(schedule)) { logger.error('ads-auto-harvest: invalid schedule', { schedule }); return }
  autoHarvestTask = cron.schedule(schedule, () => { void runAutoHarvestCron() })
  logger.info('ads-auto-harvest cron: scheduled', { schedule })
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
  // H.2e: ads-sync (Phase B per-product orchestrator) retired in favor
  // of the v1 unified export pipeline below. The v1 crons populate the
  // same Campaign/AdGroup/AdTarget/AdProductAd tables but cover all 3
  // ad products in one unified flow with cleaner schema (deliveryStatus,
  // creativeJson, first-class negatives).
  // Also retired: legacy ads-metrics-ingest cron — replaced by the
  // Phase 11 async Reports pipeline (ads-report-create/poll/ingest).
  startFbaStorageAgeIngestCron()
  startTrueProfitRollupCron()
  // AME.4 — nightly reconcile + self-heal of stored campaign metrics.
  startAdsReconcileCron()
  // AD.4 Step 6: FBA fees
  startFbaFeesIngestCron()
  // Phase 11: Reports API pipeline (performance data)
  startReportCreateCron()
  startReportCreateStCron()
  startReportCreatePlCron()
  startReportCreateApCron()
  startReportPollCron()
  startReportIngestCron()
  startSearchTermCleanupCron()
  // H.2: v1 unified export pipeline (structure data — campaigns/adGroups/targets/ads)
  startV1ExportCreateCron()
  startV1ExportPollCron()
  startV1ExportIngestCron()
  // B — live campaign-settings sync (placement bids / budget / strategy) every ~20 min.
  startCampaignSettingsSyncCron()
  // AF.7 — keep real bids after each structural sync.
  startKeywordBidResyncCron()
  // TD.0 — automation anomaly circuit-breaker.
  startAnomalyGuardCron()
  // TD.1 — automatic profit-native target-ACOS bidding.
  startAutoBidCron()
  // TD.2 — automatic keyword harvest + prune.
  startAutoHarvestCron()
}

export function stopAllAdvertisingCrons(): void {
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
    ['reportCreateApTask',  reportCreateApTask]  as const,
    ['reportPollTask',      reportPollTask]      as const,
    ['reportIngestTask',    reportIngestTask]    as const,
    ['searchTermCleanupTask', searchTermCleanupTask] as const,
    ['v1ExportCreateTask',  v1ExportCreateTask]  as const,
    ['v1ExportPollTask',    v1ExportPollTask]    as const,
    ['v1ExportIngestTask',  v1ExportIngestTask]  as const,
    ['keywordBidResyncTask', keywordBidResyncTask] as const,
    ['anomalyGuardTask', anomalyGuardTask] as const,
    ['autoBidTask', autoBidTask] as const,
    ['autoHarvestTask', autoHarvestTask] as const,
  ]) {
    if (task) { task.stop(); logger.debug(`${key} stopped`) }
  }
  reportCreateTask = null; reportCreateStTask = null; reportCreatePlTask = null; reportCreateApTask = null
  reportPollTask = null; reportIngestTask = null; searchTermCleanupTask = null
  v1ExportCreateTask = null; v1ExportPollTask = null; v1ExportIngestTask = null
  keywordBidResyncTask = null; anomalyGuardTask = null; autoBidTask = null; autoHarvestTask = null
}
