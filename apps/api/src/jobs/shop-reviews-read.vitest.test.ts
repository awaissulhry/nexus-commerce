/**
 * Reviews PR I — the two 30-minute reads are off unless their switches are on: the scheduler starts neither by default,
 * and a run with its switch off records "nothing was read" (NOT_CONFIGURED) without calling Etsy or Judge.me.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ runs: [] as Array<{ job: string; result: unknown }>, etsyReads: 0, appReads: 0 }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: async (job: string, fn: () => Promise<unknown>) => {
    const result = await fn()
    h.runs.push({ job, result })
    return result
  },
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(() => ({ stop: vi.fn() })), validate: () => true } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../services/etsy/reviews-read.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/etsy/reviews-read.js')>()
  return {
    ...real,
    readEtsyReviewsOnce: async () => {
      if (!real.etsyReviewsReadOn()) return { enabled: false, accounts: [] }
      h.etsyReads++
      return { enabled: true, accounts: [{ connectionId: 'c1', status: 'SUCCESS', seen: 3, inserted: 1, updated: 0, error: null }] }
    },
  }
})
vi.mock('../services/reviews/review-app-connection.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/reviews/review-app-connection.service.js')>()
  return {
    ...real,
    readReviewAppsOnce: async () => {
      if (!real.reviewAppReadOn()) return { enabled: false, apps: 0, seen: 0, inserted: 0, updated: 0, errors: [] }
      h.appReads++
      return { enabled: true, apps: 1, seen: 2, inserted: 2, updated: 0, errors: [] }
    },
  }
})

const job = await import('./shop-reviews-read.job.js')

beforeEach(() => {
  h.runs = []
  h.etsyReads = 0
  h.appReads = 0
  delete process.env.NEXUS_ENABLE_ETSY_REVIEWS_READ
  delete process.env.NEXUS_ENABLE_REVIEW_APP_READ
})

describe('the scheduler starts a read only when its switch is on', () => {
  it('neither by default; each by its own switch ("1" only)', () => {
    const start = { etsy: vi.fn(), app: vi.fn() }
    expect(job.startShopReviewReads({}, start)).toEqual({ etsy: false, app: false })
    expect(job.startShopReviewReads({ NEXUS_ENABLE_ETSY_REVIEWS_READ: 'true', NEXUS_ENABLE_REVIEW_APP_READ: 'yes' }, start)).toEqual({ etsy: false, app: false })
    expect(start.etsy).not.toHaveBeenCalled()
    expect(start.app).not.toHaveBeenCalled()
    expect(job.startShopReviewReads({ NEXUS_ENABLE_ETSY_REVIEWS_READ: '1' }, start)).toEqual({ etsy: true, app: false })
    expect(start.etsy).toHaveBeenCalledTimes(1)
    expect(job.startShopReviewReads({ NEXUS_ENABLE_REVIEW_APP_READ: '1' }, start)).toEqual({ etsy: false, app: true })
    expect(start.app).toHaveBeenCalledTimes(1)
  })
  it('every 30 minutes (the schedule Reviews Settings › Pipeline health shows)', async () => {
    const { pipelineJobDefs } = await import('../services/reviews/review-settings-health.js')
    const defs = pipelineJobDefs({})
    expect(job.etsyReviewsSchedule({})).toBe('*/30 * * * *')
    expect(job.reviewAppSchedule({})).toBe('*/30 * * * *')
    expect(defs.find((d) => d.key === 'etsy-reviews-read')?.schedule).toBe(job.etsyReviewsSchedule({}))
    expect(defs.find((d) => d.key === 'review-app-read')?.schedule).toBe(job.reviewAppSchedule({}))
  })
})

describe('a run with its switch off reads nothing and says so', () => {
  it('Etsy', async () => {
    await job.runEtsyReviewsReadCron()
    expect(h.etsyReads).toBe(0)
    expect(h.runs[0]).toMatchObject({ job: 'etsy-reviews-read', result: { cronStatus: 'NOT_CONFIGURED' } })
  })
  it('the review app', async () => {
    await job.runReviewAppReadCron()
    expect(h.appReads).toBe(0)
    expect(h.runs[0]).toMatchObject({ job: 'review-app-read', result: { cronStatus: 'NOT_CONFIGURED' } })
  })
  it('switched on, each run reads and records SUCCESS', async () => {
    process.env.NEXUS_ENABLE_ETSY_REVIEWS_READ = '1'
    process.env.NEXUS_ENABLE_REVIEW_APP_READ = '1'
    await job.runEtsyReviewsReadCron()
    await job.runReviewAppReadCron()
    expect([h.etsyReads, h.appReads]).toEqual([1, 1])
    expect(h.runs.map((r) => (r.result as { cronStatus: string }).cronStatus)).toEqual(['SUCCESS', 'SUCCESS'])
  })
})
