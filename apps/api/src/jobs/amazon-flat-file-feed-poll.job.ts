/**
 * FFS.3 — poll-and-reconcile cron for flat-file (JSON_LISTINGS_FEED) submissions.
 *
 * Advances IN_QUEUE / IN_PROGRESS AmazonFlatFileFeedJob rows to a terminal status
 * and captures the processing report — EVEN WHEN NO TAB IS OPEN. This is what
 * makes feed status durable: a submission is never left "stuck" because the
 * operator closed the page before it finished. Per-job nextPollAt backoff
 * (set by reconcileFeedJob) keeps us from hammering SP-API.
 *
 * Started unconditionally (sibling of the Amazon returns poll); self-guards when
 * Amazon creds are absent or there are no in-flight feeds. Schedule overridable
 * via NEXUS_FLAT_FILE_FEED_POLL_SCHEDULE.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { reconcileFeedJob } from '../services/amazon-flat-file-feed.service.js'
import { amazonCredsConfigured } from '../lib/amazon-sp-client.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runFlatFileFeedPoll(): Promise<{ polled: number; advanced: number }> {
  if (!amazonCredsConfigured()) return { polled: 0, advanced: 0 }

  const due = await prisma.amazonFlatFileFeedJob.findMany({
    where: {
      status: { in: ['IN_QUEUE', 'IN_PROGRESS'] },
      OR: [{ nextPollAt: null }, { nextPollAt: { lte: new Date() } }],
    },
    select: { feedId: true },
    orderBy: { submittedAt: 'asc' },
    take: 50,
  })
  if (!due.length) return { polled: 0, advanced: 0 }

  let advanced = 0
  for (const j of due) {
    try {
      const r = await reconcileFeedJob(j.feedId)
      if (r.terminal) advanced += 1
    } catch (e: any) {
      logger.warn('[flat-file-feed-poll] reconcile failed', { feedId: j.feedId, error: e?.message })
    }
  }
  logger.info('[flat-file-feed-poll] tick', { polled: due.length, advanced })
  return { polled: due.length, advanced }
}

export function startFlatFileFeedPollCron(): void {
  if (scheduledTask) {
    logger.warn('flat-file-feed-poll cron already started')
    return
  }
  const schedule = process.env.NEXUS_FLAT_FILE_FEED_POLL_SCHEDULE ?? '*/2 * * * *' // every 2 min
  if (!cron.validate(schedule)) {
    logger.error('flat-file-feed-poll cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runFlatFileFeedPoll()
  })
  logger.info('flat-file-feed-poll cron: scheduled', { schedule })
}

export function stopFlatFileFeedPollCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
