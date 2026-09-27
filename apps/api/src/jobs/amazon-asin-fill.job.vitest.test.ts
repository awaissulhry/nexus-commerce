/**
 * The ASIN sweep: per business, the pending rows go through the one filler; nothing pending reads nothing; the
 * schedule goes through the clustered wrapper and can be turned off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ pending: vi.fn(), fill: vi.fn(), schedule: vi.fn(), businesses: 1 }))
vi.mock('../services/amazon/listing-asin-fill.service.js', () => ({ pendingAsinListingIds: m.pending, fillAmazonListingAsins: m.fill }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, work: () => Promise<unknown>) => work() }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: m.schedule } }))
vi.mock('../lib/workspace-sweep.js', () => ({ visitActiveWorkspaces: async (work: () => Promise<void>) => { for (let i = 0; i < m.businesses; i++) await work() } }))

import { runAmazonAsinFillOnce, startAmazonAsinFillCron, stopAmazonAsinFillCron } from './amazon-asin-fill.job.js'

const counts = (filled: number, notVisible: number) => ({ filled, not_visible_yet: notVisible, already_had_asin: 0, error: 0 })

beforeEach(() => {
  vi.resetAllMocks()
  m.businesses = 1
  m.schedule.mockReturnValue({ stop: vi.fn() })
})
afterEach(() => {
  stopAmazonAsinFillCron()
  delete process.env.NEXUS_AMAZON_ASIN_FILL
  delete process.env.NEXUS_AMAZON_ASIN_FILL_SCHEDULE
})

describe('runAmazonAsinFillOnce', () => {
  it('sends each business its pending rows through the filler, and sums what happened', async () => {
    m.businesses = 2
    m.pending.mockResolvedValueOnce(['a', 'b']).mockResolvedValueOnce(['c'])
    m.fill.mockResolvedValueOnce({ counts: counts(1, 1) }).mockResolvedValueOnce({ counts: counts(1, 0) })
    const result = await runAmazonAsinFillOnce()
    expect(m.fill.mock.calls).toEqual([[['a', 'b']], [['c']]])
    expect(result.summary).toBe('read 3 · filled 2 · not visible yet 1 · already had 0 · errors 0')
  })

  it('reads nothing when nothing is pending', async () => {
    m.pending.mockResolvedValue([])
    expect((await runAmazonAsinFillOnce()).summary).toBe('read 0 · filled 0 · not visible yet 0 · already had 0 · errors 0')
    expect(m.fill).not.toHaveBeenCalled()
  })

  it('is a write run, never a dry run', async () => {
    m.pending.mockResolvedValue(['a'])
    m.fill.mockResolvedValue({ counts: counts(1, 0) })
    await runAmazonAsinFillOnce()
    expect(m.fill).toHaveBeenCalledWith(['a'])
  })
})

describe('startAmazonAsinFillCron', () => {
  it('schedules every 30 minutes through the clustered wrapper by default', () => {
    startAmazonAsinFillCron()
    expect(m.schedule).toHaveBeenCalledOnce()
    expect(m.schedule.mock.calls[0][0]).toBe('7,37 * * * *')
  })

  it('takes a schedule override', () => {
    process.env.NEXUS_AMAZON_ASIN_FILL_SCHEDULE = '*/15 * * * *'
    startAmazonAsinFillCron()
    expect(m.schedule.mock.calls[0][0]).toBe('*/15 * * * *')
  })

  it('stays off with NEXUS_AMAZON_ASIN_FILL=0', () => {
    process.env.NEXUS_AMAZON_ASIN_FILL = '0'
    startAmazonAsinFillCron()
    expect(m.schedule).not.toHaveBeenCalled()
  })
})
