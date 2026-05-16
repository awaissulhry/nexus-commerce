/**
 * AD.1 — Cron wrappers for the Trading Desk substrate jobs.
 *
 *   ads-sync                 every 30 min — pulls campaign structure
 *   fba-storage-age-ingest   every 6 hours — refreshes aged-stock feed
 *   true-profit-rollup       nightly 03:00 UTC — re-aggregates yesterday
 *
 * All three are gated by `NEXUS_ENABLE_AMAZON_ADS_CRON=1` and default
 * off in dev. In sandbox mode (`NEXUS_AMAZON_ADS_MODE=sandbox`, default)
 * they still write to DB but use fixture data instead of calling
 * Amazon. AD.2 adds `ads-metrics-ingest` (Reports API).
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

let adsSyncTask: ReturnType<typeof cron.schedule> | null = null
let fbaStorageAgeTask: ReturnType<typeof cron.schedule> | null = null
let trueProfitRollupTask: ReturnType<typeof cron.schedule> | null = null
let adsMetricsIngestTask: ReturnType<typeof cron.schedule> | null = null

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

// ── Bulk start (called from index.ts when NEXUS_ENABLE_AMAZON_ADS_CRON=1) ──

export function startAllAdvertisingCrons(): void {
  startAdsSyncCron()
  startFbaStorageAgeIngestCron()
  startTrueProfitRollupCron()
  startAdsMetricsIngestCron()
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
}
