/**
 * The keyword feed's cron: scheduled through the cluster-safe wrapper (hard rule 7), default ON with an opt-out, its
 * run recorded under one job name that the manual trigger knows too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { schedule, recorded, runKeywordRankFeed } = vi.hoisted(() => ({
  schedule: vi.fn((_expr: string, _fn: () => Promise<void>) => ({ stop: vi.fn() })),
  recorded: [] as string[],
  runKeywordRankFeed: vi.fn(async () => ({ summary: 'created=4 alreadyWritten=0 notBidOn=1 noVolume=0' })),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule, validate: (e: string) => e.split(' ').length === 5 } }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (name: string, handler: () => Promise<string>) => { recorded.push(name); return handler() }),
}))
vi.mock('../services/advertising/keyword-rank-feed.service.js', () => ({ runKeywordRankFeed }))

import {
  KEYWORD_RANK_FEED_DEFAULT_SCHEDULE, KEYWORD_RANK_FEED_JOB, runKeywordRankFeedCron, runKeywordRankFeedOnce,
  startKeywordRankFeedCron, stopKeywordRankFeedCron,
} from './keyword-rank-feed.job.js'

beforeEach(() => {
  vi.clearAllMocks()
  recorded.length = 0
  stopKeywordRankFeedCron()
  delete process.env.NEXUS_DISABLE_KEYWORD_RANK_FEED_CRON
  delete process.env.NEXUS_KEYWORD_RANK_FEED_SCHEDULE
})
afterEach(() => stopKeywordRankFeedCron())

describe('keyword-rank-feed cron', () => {
  it('is scheduled by default every 3 hours at :50 UTC, through the clustered wrapper', () => {
    startKeywordRankFeedCron()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0][0]).toBe(KEYWORD_RANK_FEED_DEFAULT_SCHEDULE)
    expect(KEYWORD_RANK_FEED_DEFAULT_SCHEDULE).toBe('50 */3 * * *')
  })

  it('is not scheduled when opted out, and refuses an invalid schedule', () => {
    process.env.NEXUS_DISABLE_KEYWORD_RANK_FEED_CRON = '1'
    startKeywordRankFeedCron()
    expect(schedule).not.toHaveBeenCalled()
    delete process.env.NEXUS_DISABLE_KEYWORD_RANK_FEED_CRON
    process.env.NEXUS_KEYWORD_RANK_FEED_SCHEDULE = 'not a schedule'
    startKeywordRankFeedCron()
    expect(schedule).not.toHaveBeenCalled()
  })

  it('a tick records its run under the job name and answers the feed\'s summary', async () => {
    startKeywordRankFeedCron()
    const tick = schedule.mock.calls[0][1]
    await tick()
    expect(recorded).toEqual([KEYWORD_RANK_FEED_JOB])
    expect(runKeywordRankFeed).toHaveBeenCalledTimes(1)
    expect(await runKeywordRankFeedOnce()).toBe('created=4 alreadyWritten=0 notBidOn=1 noVolume=0')
  })

  it('a failing run is logged, never thrown into the scheduler', async () => {
    runKeywordRankFeed.mockRejectedValueOnce(new Error('database away'))
    await expect(runKeywordRankFeedCron()).resolves.toBeUndefined()
  })
})
