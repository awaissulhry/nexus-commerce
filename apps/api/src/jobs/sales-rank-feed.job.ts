/**
 * The Best Sellers Rank feed on a clock — Amazon's rank of every live Amazon listing, stored as AmazonSalesRank rows.
 *
 * What it reads, stores and skips: services/amazon/sales-rank.service.ts.
 *
 * Every 3 hours at :17 UTC (00:17, 03:17, 06:17 …): a rank moves within hours, and a daily minute could fall in a
 * scheduler restart. Each run asks Amazon about 1 call per 20 live ASINs per market (searchCatalogItems, through the
 * gateway's rate bucket) and stores only what changed, plus a daily heartbeat. Default ON; NEXUS_SALES_RANK_FEED=off
 * (or 0) turns it off, NEXUS_SALES_RANK_FEED_SCHEDULE moves it. Started with the scheduler's other Amazon read-backs;
 * the clustered wrapper runs it once per business per tick.
 */
import cron from '../lib/cron/clustered.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'
import { SALES_RANK_FEED_DEFAULT_SCHEDULE } from '../services/amazon/sales-rank-schedule.js'

export const SALES_RANK_FEED_JOB = 'sales-rank-feed'
export { SALES_RANK_FEED_DEFAULT_SCHEDULE }

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/** One run in every business (or the caller's one); answers the summary line. */
export async function runSalesRankFeedOnce(): Promise<string> {
  const { runSalesRankFeed } = await import('../services/amazon/sales-rank.service.js')
  const lines: string[] = []
  await visitActiveWorkspaces(async () => { lines.push((await runSalesRankFeed()).summary) })
  return lines.join(' · ') || 'no business'
}

export async function runSalesRankFeedCron(): Promise<void> {
  try {
    await recordCronRun(SALES_RANK_FEED_JOB, runSalesRankFeedOnce)
  } catch (err) {
    logger.error('sales-rank-feed cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startSalesRankFeedCron(): void {
  if (scheduledTask) { logger.warn('sales-rank-feed cron already started'); return }
  if (!envEnabled('NEXUS_SALES_RANK_FEED', true)) {
    logger.info('sales-rank-feed cron disabled (NEXUS_SALES_RANK_FEED=off)')
    return
  }
  const schedule = process.env.NEXUS_SALES_RANK_FEED_SCHEDULE || SALES_RANK_FEED_DEFAULT_SCHEDULE
  if (!cron.validate(schedule)) { logger.error('sales-rank-feed cron: invalid schedule', { schedule }); return }
  scheduledTask = cron.schedule(schedule, async () => { await runSalesRankFeedCron() })
  logger.info(`sales-rank-feed cron scheduled (${schedule})`)
}

export function stopSalesRankFeedCron(): void {
  if (scheduledTask) { scheduledTask.stop(); scheduledTask = null }
}
