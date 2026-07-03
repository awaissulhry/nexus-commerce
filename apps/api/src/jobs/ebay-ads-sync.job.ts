/**
 * E2 (eBay Ads) — sync crons: entity sync (hourly), listing discovery
 * (4-hourly), report scheduler (daily), report poller/ingester (3-min),
 * economics rebuild (daily). ALL READ-ONLY against eBay (report tasks are
 * the read mechanism). Campaign/ad WRITES are E4 and live elsewhere behind
 * the marketing write gate.
 *
 * Gate: production defaults ON (ship-live), everywhere else defaults OFF —
 * NEXUS_ENABLE_EBAY_ADS_SYNC=1 forces on, =0 forces off. Schedules
 * env-overridable per cron. Every run is recordCronRun-wrapped (CronRun
 * rows → /sync-logs) with an overlap guard.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { syncEbayAdsEntities } from '../services/marketing/ebay-ads-entity-sync.service.js'
import { discoverEbayListings } from '../services/marketing/ebay-listing-index.service.js'
import { scheduleEbayReportTasks, pollAndIngestEbayReports } from '../services/marketing/ebay-ads-reports.service.js'
import { rebuildEbayListingEconomics } from '../services/ads-core/ebay-margin.js'

function gateOpen(): boolean {
  const v = process.env.NEXUS_ENABLE_EBAY_ADS_SYNC
  if (v === '0') return false
  if (v === '1') return true
  return process.env.NODE_ENV === 'production'
}

const running = { entities: false, discovery: false, schedule: false, poll: false, economics: false }

export async function runEbayAdsEntitySyncOnce(): Promise<unknown> {
  return recordCronRun('ebay-ads-entity-sync', async () => {
    const r = await syncEbayAdsEntities()
    return `campaigns=${r.campaigns} ads=${r.ads} adGroups=${r.adGroups} keywords=${r.keywords} negatives=${r.negatives} staled=${r.staledAds}${r.skippedStaleFlip ? ' CIRCUIT-BREAKER' : ''} errors=${r.errors.length}`
  })
}

export async function runEbayListingDiscoveryOnce(): Promise<unknown> {
  return recordCronRun('ebay-listing-discovery', async () => {
    const r = await discoverEbayListings()
    return `active=${r.fetchedActive} upserted=${r.upserted} detail=${r.detailFetched} matched=${r.matched} ended=${r.ended} membershipsEnded=${r.membershipsEnded}${r.skippedEndFlip ? ' CIRCUIT-BREAKER' : ''} errors=${r.errors.length}`
  })
}

export async function runEbayReportScheduleOnce(): Promise<unknown> {
  return recordCronRun('ebay-ads-report-schedule', async () => {
    const r = await scheduleEbayReportTasks()
    return `created=${r.created} skippedOpen=${r.skippedOpen} errors=${r.errors.length}${r.errors.length ? ` [${r.errors[0]}]` : ''}`
  })
}

export async function runEbayReportPollOnce(): Promise<unknown> {
  return recordCronRun('ebay-ads-report-poll', async () => {
    const r = await pollAndIngestEbayReports()
    return `polled=${r.polled} succeeded=${r.succeeded} ingested=${r.ingested} rows=${r.rows} failed=${r.failed} errors=${r.errors.length}`
  })
}

export async function runEbayEconomicsRebuildOnce(): Promise<unknown> {
  return recordCronRun('ebay-ads-economics-rebuild', async () => {
    const r = await rebuildEbayListingEconomics()
    return `listings=${r.listings} estimated=${r.estimated} missingCogs=${r.missingCogs} missingPrice=${r.missingPrice}`
  })
}

function guard(key: keyof typeof running, fn: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    if (running[key]) return
    running[key] = true
    try { await fn() } catch (e) {
      logger.error(`[E2][ebay-ads] ${key} cron failed: ${(e as Error).message}`)
    } finally { running[key] = false }
  }
}

export function startEbayAdsSyncCrons(): void {
  if (!gateOpen()) {
    logger.info('[E2][ebay-ads] sync crons disabled (NEXUS_ENABLE_EBAY_ADS_SYNC gate)')
    return
  }
  cron.schedule(process.env.NEXUS_EBAY_ADS_ENTITY_SCHEDULE ?? '10 * * * *', guard('entities', runEbayAdsEntitySyncOnce))
  cron.schedule(process.env.NEXUS_EBAY_ADS_DISCOVERY_SCHEDULE ?? '25 */4 * * *', guard('discovery', runEbayListingDiscoveryOnce))
  cron.schedule(process.env.NEXUS_EBAY_ADS_REPORT_SCHEDULE ?? '40 2 * * *', guard('schedule', runEbayReportScheduleOnce))
  cron.schedule(process.env.NEXUS_EBAY_ADS_POLL_SCHEDULE ?? '*/3 * * * *', guard('poll', runEbayReportPollOnce))
  cron.schedule(process.env.NEXUS_EBAY_ADS_ECONOMICS_SCHEDULE ?? '15 5 * * *', guard('economics', runEbayEconomicsRebuildOnce))
  logger.info('[E2][ebay-ads] sync crons scheduled (entity hourly, discovery 4h, reports daily, poll 3min, economics daily)')
}
