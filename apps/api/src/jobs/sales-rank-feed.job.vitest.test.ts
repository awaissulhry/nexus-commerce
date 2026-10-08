/**
 * The Best Sellers Rank feed's cron: scheduled through the cluster-safe wrapper (hard rule 7), every 3 hours at :17 UTC,
 * default ON with an opt-out, its run recorded under one job name the manual trigger knows too, and a failure logged
 * rather than thrown into the scheduler.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { schedule, recorded, runSalesRankFeed } = vi.hoisted(() => ({
  schedule: vi.fn((_expr: string, _fn: () => Promise<void>) => ({ stop: vi.fn() })),
  recorded: [] as string[],
  runSalesRankFeed: vi.fn(async () => ({ summary: 'asins=3 batches=1 written=2 unchanged=1 noRank=0 failedBatches=0 skipped=0 pruned=0' })),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule, validate: (e: string) => e.split(' ').length === 5 } }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (name: string, handler: () => Promise<string>) => { recorded.push(name); return handler() }),
}))
vi.mock('../lib/workspace-sweep.js', () => ({ visitActiveWorkspaces: async (work: () => Promise<void>) => { await work() } }))
vi.mock('../services/amazon/sales-rank.service.js', () => ({ runSalesRankFeed }))

import {
  SALES_RANK_FEED_DEFAULT_SCHEDULE, SALES_RANK_FEED_JOB, runSalesRankFeedCron, runSalesRankFeedOnce, startSalesRankFeedCron, stopSalesRankFeedCron,
} from './sales-rank-feed.job.js'

beforeEach(() => {
  vi.clearAllMocks()
  recorded.length = 0
  stopSalesRankFeedCron()
  delete process.env.NEXUS_SALES_RANK_FEED
  delete process.env.NEXUS_SALES_RANK_FEED_SCHEDULE
})
afterEach(() => stopSalesRankFeedCron())

describe('sales-rank-feed cron', () => {
  it('is scheduled by default every 3 hours at :17 UTC, through the clustered wrapper', () => {
    startSalesRankFeedCron()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0][0]).toBe(SALES_RANK_FEED_DEFAULT_SCHEDULE)
    expect(SALES_RANK_FEED_DEFAULT_SCHEDULE).toBe('17 */3 * * *')
  })

  it('NEXUS_SALES_RANK_FEED=off (or 0) turns it off; an invalid schedule is refused; another schedule moves it', () => {
    for (const off of ['off', '0', 'false']) {
      process.env.NEXUS_SALES_RANK_FEED = off
      startSalesRankFeedCron()
    }
    expect(schedule).not.toHaveBeenCalled()
    delete process.env.NEXUS_SALES_RANK_FEED
    process.env.NEXUS_SALES_RANK_FEED_SCHEDULE = 'not a schedule'
    startSalesRankFeedCron()
    expect(schedule).not.toHaveBeenCalled()
    process.env.NEXUS_SALES_RANK_FEED_SCHEDULE = '5 */6 * * *'
    startSalesRankFeedCron()
    expect(schedule.mock.calls[0][0]).toBe('5 */6 * * *')
  })

  it('a tick records its run under the job name and answers the feed\'s summary; the manual trigger knows it', async () => {
    startSalesRankFeedCron()
    await schedule.mock.calls[0][1]()
    expect(recorded).toEqual([SALES_RANK_FEED_JOB])
    expect(runSalesRankFeed).toHaveBeenCalledTimes(1)
    expect(await runSalesRankFeedOnce()).toContain('written=2')
    // Read as text: importing the registry loads every job of the platform.
    expect(readFileSync(new URL('./cron-registry.ts', import.meta.url), 'utf8')).toContain(`'${SALES_RANK_FEED_JOB}': () => runSalesRankFeedOnce()`)
  })

  it('a failing run is logged, never thrown into the scheduler', async () => {
    runSalesRankFeed.mockRejectedValueOnce(new Error('database away'))
    await expect(runSalesRankFeedCron()).resolves.toBeUndefined()
  })
})
