/**
 * The Keyword Tracker's feed on a clock — `KeywordRank` rows from Amazon Brand Analytics weeks Nexus already holds.
 *
 * What it writes and why the rank columns stay empty: services/advertising/keyword-rank-feed.service.ts.
 *
 * Every 3 hours at :50 UTC (00:50, 03:50, 06:50 …): half an hour after each sqp-collect pass (:20) that may have landed
 * a new Brand Analytics week. Not once a day, because the scheduler restarted every 10–40 minutes on 2026-10-06/07 and a
 * single daily minute can fall in a restart; a run with nothing new writes nothing, so the extra runs cost a few small
 * reads. No marketplace call, so it is default ON; opt out with NEXUS_DISABLE_KEYWORD_RANK_FEED_CRON=1, move it with
 * NEXUS_KEYWORD_RANK_FEED_SCHEDULE. Started with the other advertising crons (startAllAdvertisingCrons), so it runs
 * only where those run.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

export const KEYWORD_RANK_FEED_JOB = 'keyword-rank-feed'
export const KEYWORD_RANK_FEED_DEFAULT_SCHEDULE = '50 */3 * * *'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/** One run, in the business the caller is in; answers its summary line. */
export async function runKeywordRankFeedOnce(): Promise<string> {
  const { runKeywordRankFeed } = await import('../services/advertising/keyword-rank-feed.service.js')
  return (await runKeywordRankFeed()).summary
}

export async function runKeywordRankFeedCron(): Promise<void> {
  try {
    await recordCronRun(KEYWORD_RANK_FEED_JOB, runKeywordRankFeedOnce)
  } catch (err) {
    logger.error('keyword-rank-feed cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startKeywordRankFeedCron(): void {
  if (scheduledTask) { logger.warn('keyword-rank-feed cron already started'); return }
  if (envEnabled('NEXUS_DISABLE_KEYWORD_RANK_FEED_CRON')) {
    logger.info('keyword-rank-feed cron disabled (NEXUS_DISABLE_KEYWORD_RANK_FEED_CRON=1)')
    return
  }
  const schedule = process.env.NEXUS_KEYWORD_RANK_FEED_SCHEDULE ?? KEYWORD_RANK_FEED_DEFAULT_SCHEDULE
  if (!cron.validate(schedule)) { logger.error('keyword-rank-feed cron: invalid schedule', { schedule }); return }
  scheduledTask = cron.schedule(schedule, async () => { await runKeywordRankFeedCron() })
  logger.info(`keyword-rank-feed cron scheduled (${schedule})`)
}

export function stopKeywordRankFeedCron(): void {
  if (scheduledTask) { scheduledTask.stop(); scheduledTask = null }
}
